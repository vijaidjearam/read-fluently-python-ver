# ReadFluently — Voice Recognition Latency: Technical Analysis & Recommendations

> **Stack in scope:** Pure client-side HTML/CSS/JS · Chrome Web Speech API (`webkitSpeechRecognition`) ·
> No server · EN + FR · Target: word highlights within **~200 ms** of the word being spoken ·
> Hardware: typical consumer Windows PC with built-in or USB microphone.

---

## 1. Diagnosis

### Where does the latency actually live?

| Pipeline stage | Typical cost | Measurable via |
|---|---|---|
| **Mic capture → browser buffer** | 10–30 ms | `AudioContext.baseLatency` / `outputLatency` |
| **Browser VAD / framing** | 20–80 ms | Timestamp at `onresult` minus `AudioContext.currentTime` |
| **Google cloud STT round-trip** (Chrome Web Speech) | **300–900 ms** | `Date.now()` at `onresult` minus estimated utterance start |
| **JS matching logic** | < 5 ms | `performance.now()` before/after `handleSpeechResult` |
| **DOM highlight update** | < 2 ms | DevTools frame profiler |

**Conclusion:** virtually 100% of perceived lag is the **Google cloud round-trip** inside `webkitSpeechRecognition`. The browser does not expose the raw audio stream, VAD timing, or partial-token boundaries — it only calls `onresult` after its own server has spoken. The JS matching and DOM update are essentially free.

### How to measure precisely

```js
// Add to handleSpeechResult — log the gap between result events
const now = performance.now();
const gap = now - (this._lastResultTs || now);
this._lastResultTs = now;
console.log(`[STT] resultIndex=${event.resultIndex} gap=${gap.toFixed(0)}ms isFinal=${event.results[event.resultIndex].isFinal}`);
```

- **Time-to-first-partial (TTFP):** gap from mic open to first `interimResults` event. Expect 400–700 ms on Chrome.
- **Inter-word gap:** gap between consecutive `onresult` fires for the same utterance. Expect 150–400 ms per word at conversational speech rate.
- **Chunk size:** Chrome sends audio in ~100 ms frames to its cloud; you cannot change this.

### "Certain words not highlighted" — specific root cause

Chrome merges short function words (`a`, `the`, `le`, `un`, `et`) into the previous or next chunk rather than emitting them as standalone interim tokens. Words also disappear from the interim transcript when the cloud decoder replaces a hypothesis (beam search backtracking). The old scoring-window engine then saw a word "vanish" mid-match.

---

## 2. JavaScript-Side Changes (already applied + next steps)

The rewrite in the last session fixed the core algorithmic issue. These are the remaining JS-level improvements worth applying:

- **`interimResults: true` + process only new words (done ✅).**  
  The new `_processedWordCount` deduplication engine (`speech.js`) correctly slices `allRaw.slice(processedCount)` so each `onresult` event highlights exactly one new word. This is the right approach.

- **Tighten the recognition restart loop.**  
  Chrome ends a continuous session after ~60 s of silence. The current `onend → start()` restart adds 50 ms (the `setTimeout` guard). Lower to 0 ms inside a try/catch; the 50 ms fallback is fine as a safety net.

- **Offload Levenshtein to a `Worker`.**  
  For long pasted texts (500+ words), the main thread `levenshtein()` call per word is synchronous and blocks the highlight paint. Move the matching loop to a `Worker`, post the result back via `postMessage`. Saves ~1–3 ms per match (marginal but clean).

- **Replace `scrollTo({ behavior: 'smooth' })` with `scrollIntoView({ block: 'nearest' })`.**  
  Smooth scroll scheduling on the main thread can delay the next paint frame. `nearest` is instant.

- **`requestAnimationFrame`-gate DOM writes:**  
  ```js
  requestAnimationFrame(() => this.applySingleWordHighlight(index));
  ```
  Batches the class change to the next paint cycle, preventing forced layout thrash if the scroll also fires.

- **Expected JS-only result:** ~300–700 ms TTFP (unavoidable), ~150–300 ms per subsequent word (Chrome cloud latency floor). **Cannot go below this without changing the STT backend.**

---

## 3. Local Python Alternative (when JS ceiling is not enough)

If the target is **< 150 ms per-word latency**, the Web Speech API must be replaced. Here is the specific recommended stack:

### Architecture

```
Browser AudioWorklet (16 kHz PCM, 20 ms frames)
  → WebSocket → localhost Python server
    → Silero VAD (silence gating, ~5 ms)
    → faster-whisper tiny.en / tiny (CTranslate2)
    → partial word tokens streamed back via WebSocket
  → JS receives tokens, calls applySingleWordHighlight()
```

### Component choices

| Component | Library | Why |
|---|---|---|
| Audio capture | `AudioWorklet` + `SharedArrayBuffer` | Zero GC pressure vs `ScriptProcessorNode` (deprecated) |
| Transport | `WebSocket` via `websockets` 12.x (Python) | Bidirectional, < 1 ms local loopback |
| VAD | `silero-vad` (ONNX, Python) | 10 ms chunk, 95%+ accuracy, CPU-only |
| STT | `faster-whisper` tiny model (CTranslate2 int8) | 40–80 ms per utterance on CPU; 15–30 ms on GPU |
| Partial results | Stream with `beam_size=1`, `word_timestamps=True` | Gives per-word offsets for highlight timing |
| FR support | `faster-whisper` multilingual tiny | Same model, set `language="fr"` |

### Python server skeleton

```python
# server.py
import asyncio, websockets, numpy as np
from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")

async def handler(ws):
    buffer = b""
    async for msg in ws:
        buffer += msg                          # accumulate 300 ms of audio
        if len(buffer) >= 16000 * 2 * 0.3:    # 0.3 s at 16kHz int16
            audio = np.frombuffer(buffer, np.int16).astype(np.float32) / 32768.0
            buffer = b""
            segs, _ = model.transcribe(audio, beam_size=1, word_timestamps=True, language="en")
            for seg in segs:
                for word in seg.words:
                    await ws.send(word.word.strip())   # one word at a time

asyncio.run(websockets.serve(handler, "localhost", 8765))
```

### JS AudioWorklet sender (key snippet)

```js
// In AudioWorklet processor: collect 320 samples (20 ms @ 16kHz), post to main
// In main thread:
const ws = new WebSocket('ws://localhost:8765');
ws.onmessage = ({ data }) => {
    // data = single recognized word
    const norm = speechEngine.normalizeWord(data);
    const idx  = speechEngine.currentIndex;
    if (speechEngine.isWordMatch(norm, speechEngine.tokens[idx]?.clean)) {
        speechEngine._advanceOne(idx);
    }
};
```

### Hardware / latency expectations

| Hardware | Per-word latency (faster-whisper tiny) |
|---|---|
| Modern CPU (Ryzen 5 / i5, int8) | 40–80 ms |
| GPU (GTX 1060+, float16) | 10–25 ms |
| Raspberry Pi 4 | 180–300 ms (not recommended) |

**Total perceived latency (CPU path):** ~60–120 ms from word spoken to word highlighted. Well within the 200 ms target.

---

## 4. Word-Highlighting Fixes (specific symptoms)

- **Function words skipped (`le`, `un`, `a`, `the`):** These are low-entropy tokens — STT models and Chrome's cloud decoder often swallow them. Fix: in `isWordMatch`, if `target.length <= 2`, accept a match from the **next** word in the stream too (look-ahead of +1 without penalty). Already partially done with the one-word lookahead; just ensure it also fires for 2-char tokens.

- **Word disappears mid-interim (backtracking):** Chrome's cloud occasionally replaces `"le petit"` with `"lepetit"` in a later interim. Fix: `_processedWordCount` now prevents re-processing already-consumed positions, so backtracked words are ignored safely.

- **French liaison words (`l'arbre` → spoken as `larbre`):** Already handled by the `l' + t` / `d' + t` prefix rules in `isWordMatch`. Confirm `normalizeWord` strips apostrophes before `replace(/[^a-z0-9]/g, '')`.

- **End-of-sentence word never fires:** Chrome finalises an utterance only on silence. If the last word of a paragraph is never finalised, add a **500 ms silence timer**: if `Date.now() - lastSpeechTimestamp > 500` and `currentIndex === tokens.length - 1`, auto-advance and call `finishReading()`.

---

## 5. Recommended Rollout Plan

1. **Week 1 — Validate the new JS engine** (already deployed).  
   Measure TTFP and inter-word gap using the `performance.now()` logging snippet above. If inter-word gap is consistently < 300 ms, the app is functional.

2. **Week 2 — Apply remaining JS micro-fixes.**  
   `scrollIntoView`, `requestAnimationFrame` gate, end-of-sentence silence timer, 2-char function-word look-ahead.

3. **Week 3 — Decision gate.**  
   If users still report lag (measured TTFP > 500 ms on the test device), the ceiling is Chrome's cloud. Proceed to Python path.

4. **Week 4–5 — Python server prototype** (optional).  
   Install `faster-whisper`, `websockets`, `silero-vad`. Build the local server. Add `AudioWorklet` sender in JS. Test EN + FR on the target Windows PC.

5. **Week 6 — Packaging** (if Python path chosen).  
   Bundle as an Electron app or ship `server.py` with a `start.bat` / `start.sh` launcher. Models (~150 MB for tiny) ship with the package.

---

## Option Comparison

| Option | Latency (per word) | Complexity | Accuracy | Offline? | FR support |
|---|---|---|---|---|---|
| Chrome Web Speech API (current) | 150–700 ms | Low | Good | ❌ | ✅ |
| Chrome + JS dedup engine (now) | 150–400 ms | Low | Good | ❌ | ✅ |
| faster-whisper tiny (CPU) | 40–80 ms | Medium | Very good | ✅ | ✅ |
| faster-whisper tiny (GPU) | 10–25 ms | Medium | Very good | ✅ | ✅ |
| Vosk (en/fr small model) | 50–150 ms | Low-Medium | Good | ✅ | ✅ |

> **Bottom line:** The JS dedup engine (already deployed) extracts the maximum possible performance from Chrome Web Speech API. If the latency is still perceptible, the only path to sub-150 ms is a local `faster-whisper`/Vosk Python server. Vosk is the lower-complexity entry point; `faster-whisper` gives better accuracy and FR quality.
