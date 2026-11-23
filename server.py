#!/usr/bin/env python3
"""
ReadFluently — Local AI Speech Server
======================================
• HTTP  → http://localhost:8080  (serves the app files so Chrome's mic + AudioWorklet work)
• WS    → ws://localhost:8765    (real-time faster-whisper speech recognition)

Workflow per utterance:
  Browser AudioWorklet → 20 ms Int16 PCM frames → WebSocket
  → RMS VAD accumulates until 400 ms silence
  → faster-whisper tiny (int8 CPU) transcribes
  → word tokens streamed back one-by-one → JS highlights matching word
"""

import asyncio
import json
import logging
import os
import sys
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
import socketserver

import numpy as np

# ── Dependency checks ────────────────────────────────────────────────────────
try:
    import websockets
except ImportError:
    sys.exit("❌  Missing: pip install websockets>=11.0")

try:
    from faster_whisper import WhisperModel
except ImportError as exc:
    sys.exit(
        "❌  faster-whisper could not be imported: "
        f"{exc}\nInstall all dependencies with: python -m pip install -r requirements.txt"
    )

# ── Configuration ────────────────────────────────────────────────────────────
HTTP_HOST = "localhost"
HTTP_PORT = 8080
WS_HOST   = "localhost"
WS_PORT   = 8765

APP_DIR   = Path(__file__).parent   # folder that contains index.html

SAMPLE_RATE         = 16000   # Hz — must match browser AudioContext sampleRate
FRAME_SAMPLES       = 320     # 20 ms @ 16 kHz
SILENCE_RMS         = 0.015   # RMS below this level is treated as silence
SILENCE_FRAMES_END  = 20      # 20 × 20 ms = 400 ms silence → end of utterance
MIN_SPEECH_FRAMES   = 5       #  5 × 20 ms = 100 ms minimum speech before we try

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s]  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("readfluently")

# ── Load model once at startup ────────────────────────────────────────────────
def load_model_with_progress():
    """Load once; emit a heartbeat while the initial model download/load runs."""
    log.info("Loading faster-whisper tiny model (CPU / int8).")
    log.info("First run downloads the model to ~/.cache/huggingface; download progress may also appear below.")
    loader = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-loader")
    future = loader.submit(WhisperModel, "tiny", device="cpu", compute_type="int8")
    try:
        while True:
            try:
                loaded = future.result(timeout=10)
                break
            except FutureTimeoutError:
                log.info("Still loading/downloading the Whisper model; please wait…")
        log.info("✅  Model loaded and ready.")
        return loaded
    finally:
        loader.shutdown(wait=True)


model = load_model_with_progress()

executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="whisper")


# ── Blocking transcription (called in ThreadPoolExecutor) ────────────────────
def transcribe_sync(audio_np, language):
    """
    Runs faster-whisper synchronously in a worker thread so the asyncio
    event loop is never blocked.  Returns a list of recognised word strings.
    """
    segments, _info = model.transcribe(
        audio_np,
        language=language,
        beam_size=1,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 200,
            "speech_pad_ms": 80,
        },
        condition_on_previous_text=False,
        no_speech_threshold=0.45,
        log_prob_threshold=-1.0,
        temperature=0.0,
    )
    words = []
    for seg in segments:
        for w in seg.words:
            token = w.word.strip()
            if token:
                words.append(token)
    return words


# ── Simple energy-based VAD accumulator ─────────────────────────────────────
class AudioBuffer:
    """
    Accumulates 20 ms PCM frames.
    Returns True from push() when an utterance boundary (400 ms silence
    after at least 100 ms of speech) is detected.
    """

    def __init__(self):
        self._frames = []
        self._n_silent = 0
        self._n_speech = 0

    def push(self, frame):
        """Add a Float32 frame.  Returns True when utterance ends."""
        self._frames.append(frame)
        rms = float(np.sqrt(np.mean(frame ** 2)))
        if rms >= SILENCE_RMS:
            self._n_silent = 0
            self._n_speech += 1
        else:
            self._n_silent += 1
        return (
            self._n_speech >= MIN_SPEECH_FRAMES
            and self._n_silent >= SILENCE_FRAMES_END
        )

    def flush(self):
        """Return concatenated audio array and reset, or None if too short."""
        if self._n_speech < MIN_SPEECH_FRAMES:
            self._reset()
            return None
        audio = np.concatenate(self._frames)
        self._reset()
        return audio

    def _reset(self):
        self._frames = []
        self._n_silent = 0
        self._n_speech = 0


# ── WebSocket handler (one coroutine per connected browser tab) ──────────────
async def ws_handler(ws):
    addr = getattr(ws, "remote_address", "?")
    log.info(f"WS client connected: {addr}")
    buf  = AudioBuffer()
    lang = "en"
    loop = asyncio.get_event_loop()

    try:
        async for msg in ws:

            # ── Control message (JSON string) ─────────────────────────────
            if isinstance(msg, str):
                try:
                    ctrl = json.loads(msg)
                    t = ctrl.get("type", "")
                    if t == "language":
                        lang = ctrl.get("lang", "en")
                        log.info(f"Language → {lang}")
                    elif t == "reset":
                        buf = AudioBuffer()
                        log.info("Buffer reset by client")
                except json.JSONDecodeError:
                    pass
                continue

            # ── Audio frame (binary: 16-bit PCM, 320 samples = 20 ms) ─────
            if len(msg) < 2:
                continue
            frame = np.frombuffer(msg, dtype=np.int16).astype(np.float32) / 32768.0

            if not buf.push(frame):
                continue   # keep accumulating

            # Utterance boundary reached — transcribe
            audio_np = buf.flush()
            if audio_np is None or len(audio_np) == 0:
                continue

            duration = len(audio_np) / SAMPLE_RATE
            log.info(f"Transcribing {duration:.2f}s [{lang}] …")

            words = await loop.run_in_executor(
                executor, transcribe_sync, audio_np, lang
            )
            log.info(f"→ {words}")

            # Stream each word back immediately as it comes out of the model
            for w in words:
                payload = json.dumps({"type": "word", "word": w})
                await ws.send(payload)

    except websockets.exceptions.ConnectionClosed:
        log.info(f"WS client disconnected: {addr}")
    except Exception as exc:
        log.error(f"WS handler error: {exc}", exc_info=True)


# ── HTTP file server (serves index.html + js/ + css/) ────────────────────────
class QuietHTTPHandler(SimpleHTTPRequestHandler):
    """Serve files from APP_DIR; suppress per-request log noise."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass   # comment this out for verbose HTTP logging


def _run_http_server():
    with socketserver.TCPServer((HTTP_HOST, HTTP_PORT), QuietHTTPHandler) as httpd:
        httpd.allow_reuse_address = True
        log.info(f"HTTP  → http://{HTTP_HOST}:{HTTP_PORT}")
        httpd.serve_forever()


# ── Entry point ──────────────────────────────────────────────────────────────
async def main():
    # Start HTTP server in a background daemon thread
    t = threading.Thread(target=_run_http_server, daemon=True, name="http-server")
    t.start()

    log.info(f"WS    → ws://{WS_HOST}:{WS_PORT}")
    log.info("─" * 60)
    log.info(f"  Open Chrome at:  http://localhost:{HTTP_PORT}")
    log.info("  Press Ctrl+C to stop the server.")
    log.info("─" * 60)

    # Open the browser automatically (after a short delay so HTTP server is up)
    await asyncio.sleep(1.5)
    webbrowser.open(f"http://localhost:{HTTP_PORT}")

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT, max_size=2 ** 20):
        await asyncio.Future()   # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Server stopped.")
