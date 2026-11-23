# ReadFluently — AI Speech Mode Installation Guide
> Uses **faster-whisper tiny** (CPU, int8) for 40–120 ms per-word highlighting latency.  
> Falls back automatically to Chrome Web Speech API if the Python server is not running.

---

## What was added to the project

```
read-fluently/
├── server.py          ← Python WebSocket + HTTP server (NEW)
├── requirements.txt   ← Python dependencies (NEW)
├── start.bat          ← One-click launcher for Windows (NEW)
└── js/
    └── speech.js      ← Dual-backend engine: Whisper + Web Speech (UPDATED)
```

---

## Step 1 — Install Python 3.11

> [!IMPORTANT]
> Python 3.8 or newer is required. Python 3.11 is recommended.

1. Go to **https://www.python.org/downloads/**
2. Click **Download Python 3.11.x** (latest 3.11)
3. Run the installer
4. ✅ **Check the box: "Add Python to PATH"** (critical — without this, nothing works)
5. Click **Install Now**

Verify the install by opening a new Command Prompt and typing:
```
python --version
```
You should see something like `Python 3.11.9`.

---

## Step 2 — Run the app

1. Open **File Explorer** and go to your app folder:  
   `C:\Users\user\Downloads\read-fluently\`

2. Double-click **`start.bat`**

A black console window will open and do the following automatically:
- Verify Python is installed
- Install `faster-whisper`, `websockets`, `numpy` via pip
- Download the Whisper tiny model (~150 MB, **first run only**)
- Start the HTTP server on port 8080
- Start the WebSocket speech server on port 8765
- Open **Chrome** at `http://localhost:8080`

> [!NOTE]
> The first launch takes 1–3 minutes while the model downloads and loads.  
> Subsequent launches take about 5–10 seconds.

---

## Step 3 — Allow microphone access in Chrome

When you click **🎙️ Start Reading Aloud** for the first time, Chrome will ask:

> *"http://localhost:8080 wants to use your microphone"*

Click **Allow**. This permission is remembered for `localhost:8080`.

---

## Step 4 — Read!

The status badge will show **🤖 Whisper AI mode active** when the Python server is connected.

| Badge | Meaning |
|---|---|
| 🤖 Whisper AI mode active | ✅ AI backend connected — 40–120 ms latency |
| 🟢 Microphone is listening | ✅ Recording started |
| ⚪ (no Whisper badge) | Using Chrome Web Speech API fallback |

---

## How the dual-backend works

```
start.bat running?
       │
       ├─ YES → AudioWorklet mic → WebSocket :8765 → faster-whisper → word tokens
       │         Latency: 40–120 ms per word (CPU)
       │
       └─ NO  → Chrome Web Speech API (cloud)
                 Latency: 150–500 ms per word
                 (app still works — just slower highlighting)
```

> [!TIP]
> You can use the app without `start.bat` — it falls back to Chrome Web Speech automatically.  
> Always launch via `start.bat` for the best real-time highlighting experience.

---

## Stopping the server

Press **Ctrl+C** in the console window, or simply close it.

---

## Troubleshooting

### "Python is not installed or not in your PATH"
Reinstall Python from python.org and **check "Add Python to PATH"** during installation.

### "Failed to install dependencies"
Try running `start.bat` as Administrator (right-click → Run as administrator).  
Or manually run in a Command Prompt:
```
cd C:\Users\user\Downloads\read-fluently
pip install -r requirements.txt
```

### App opens but no Whisper badge shows
The Python server is not running. Make sure the console window from `start.bat` is still open and shows `✅ Model loaded and ready.`

### "Microphone not working" / no words highlighted
- Make sure you clicked **Allow** when Chrome asked for microphone permission
- Check Chrome → Settings → Privacy → Site Settings → Microphone → `localhost:8080` should be **Allowed**
- Try a different microphone if available

### Words highlighted but with a slight delay
This is normal — the VAD waits for 400 ms of silence to know an utterance has ended before transcribing. This is a tradeoff between accuracy and latency. Try speaking in short phrases (3–6 words at a time) rather than very long sentences.

### Port already in use error
Another process is using port 8080 or 8765. Close other applications, or edit `server.py` and change `HTTP_PORT` / `WS_PORT` to different numbers (e.g. 8081 / 8766).

---

## System requirements

| Component | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 | Windows 11 |
| Python | 3.8 | 3.11 |
| RAM | 4 GB | 8 GB |
| CPU | Intel i3 / Ryzen 3 | Intel i5 / Ryzen 5 |
| Browser | Chrome 90+ | Chrome latest |
| Mic | Built-in | USB/headset mic |
| Internet | Required for first model download | Not needed after that |

---

## What the Python server does (technical summary)

1. **HTTP server** (port 8080) — serves `index.html`, `js/`, `css/` so Chrome treats the app as `http://localhost` (required for `AudioWorklet` and microphone access)
2. **WebSocket server** (port 8765) — receives 20 ms audio frames, accumulates until 400 ms of silence detected (VAD), transcribes with **faster-whisper tiny int8**, streams word tokens back one-by-one
3. **faster-whisper tiny** — 39 MB model, runs entirely on CPU, no GPU needed, works fully offline after first download

> [!NOTE]
> Your voice audio is processed **entirely on your computer**. Nothing is sent to any cloud service when using AI mode.
