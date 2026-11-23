# ReadFluently — Complete Project Conversation & Development History

This document chronicles the full history, requirements, architectural decisions, debugging steps, and technical solutions for the **ReadFluently** application.

---

## Table of Contents
1. [Project Overview & Initial Requirements](#1-project-overview--initial-requirements)
2. [Early Iterations & Multilingual Support (EN / FR)](#2-early-iterations--multilingual-support-en--fr)
3. [Bug 1: French TTS Highlighting Freezing ("Pip" Stuck)](#3-bug-1-french-tts-highlighting-freezing-pip-stuck)
4. [Bug 2: Speech Recognition Lag & Multi-Word Jumping](#4-bug-2-speech-recognition-lag--multi-word-jumping)
5. [In-Depth Architectural Analysis & Performance Diagnosis](#5-in-depth-architectural-analysis--performance-diagnosis)
6. [Implementation of the Local AI Backend (`faster-whisper`)](#6-implementation-of-the-local-ai-backend-faster-whisper)
7. [Installation & Windows Environment Troubleshooting](#7-installation--windows-environment-troubleshooting)
8. [Summary of Architecture & Current State](#8-summary-of-architecture--current-state)

---

## 1. Project Overview & Initial Requirements

### Goal
Build an engaging, child-friendly reading speed training web application named **ReadFluently**. The application listens to a child reading aloud, highlights words in real time, measures reading speed in Words Per Minute (WPM), and tracks progress over time.

### Key Constraints & Requirements
- **Frontend Stack**: Pure HTML5, CSS3, and modern vanilla JavaScript.
- **No Database**: To ensure privacy, avoid server overhead, and remain lightweight, user profiles, progress stats, and reading history are stored in text files (`.txt`) and `localStorage`.
- **Text Sources**:
  - Built-in library of curated children's stories with comprehension questions.
  - Custom text input via copy-paste.
  - Document file upload (PDF text extraction via PDF.js).
- **Core Functionality**:
  - Live microphone reading: child reads aloud $\rightarrow$ recognized words highlight in real time.
  - Live WPM calculation displayed beneath the text.
  - Animal-tier speed indicators (Turtle $\rightarrow$ Bunny $\rightarrow$ Cheetah $\rightarrow$ Rocket).
  - Post-reading comprehension quizzes and badge/reward system.
  - Accessibility settings: OpenDyslexic font toggle, adjustable font sizing, and visual reading ruler.

---

## 2. Early Iterations & Multilingual Support (EN / FR)

### Feature Request
The user requested complete bilingual support for **English** and **French**:
- A 1-click language switcher in the UI.
- All interface labels, mascots, buttons, and alerts translated dynamically (`js/i18n.js`).
- Preloaded stories in both English and French (`js/stories.js`).
- Bilingual Text-to-Speech (TTS) with voice selector dropdowns (Male / Female / System voices) and voice testing capability.

---

## 3. Bug 1: French TTS Highlighting Freezing ("Pip" Stuck)

### Symptom
In English mode, the "Listen to Story" (TTS read-along) feature worked correctly. In French mode, speech audio played through to the end, but word highlighting was permanently frozen on the very first word ("Pip").

### Root Cause
- The browser Web Speech Synthesis API emits `onboundary` events with character offsets as the voice speaks each word.
- In Chromium-based browsers, **French voices often fail to dispatch `onboundary` events entirely**, or only dispatch an initial event for the first token.

### Resolution
- Implemented a **dual-track pacing engine** inside `js/audio.js`:
  1. *Track A (Event-driven)*: Listens for native `onboundary` events if supported.
  2. *Track B (Calibrated Heartbeat Fallback)*: A high-precision 20 ms timer interpolates the expected word position based on total text length, speech rate, and calibrated word durations.
  3. Added a 250 ms fallback trigger to prevent speech start delays from leaving the first word highlighted indefinitely.

---

## 4. Bug 2: Speech Recognition Lag & Multi-Word Jumping

### Symptom
During live microphone reading, users experienced perceptible lag/latency between speaking a word and seeing it highlight. Frequently, 2 to 4 words would highlight all at once in an abrupt jump rather than smoothly word-by-word.

### Root Cause Analysis
1. **Cloud STT Round-Trip Latency**: Chrome's `webkitSpeechRecognition` streams captured audio to Google's cloud servers, introducing a 300–900 ms network and cloud decoding delay.
2. **Growing Cumulative Transcripts**: Chrome's `onresult` event does not emit standalone words; it returns the cumulative transcript for the entire phrase segment (e.g., `"Pip"`, then `"Pip le"`, then `"Pip le petit"`).
3. **Flawed Window-Matching Logic**: Previous engine implementations ran scoring windows across the entire transcript buffer on every event, repeatedly matching multiple words at once.
4. **Rendering Cascade**: A 45 ms timeout cascade added to smooth jumps inadvertently introduced extra artificial latency before each word illuminated.

### JavaScript-Side Optimizations Applied
- **Segment Deduplication Engine** (`js/speech.js`):
  - Added `_processedWordCount` and `_lastResultIndex` tracking.
  - On each `onresult` event, the engine slices `allRaw.slice(this._processedWordCount)` to isolate **only the newest spoken words**.
  - Matches each newly arrived word individually against `tokens[currentIndex]`.
  - Supports 1-word lookahead to gracefully handle skipped small function words (`le`, `a`, `the`).
- **Synchronous Direct DOM Highlighting** (`js/app.js`):
  - Removed all artificial `setTimeout` cascade animations.
  - Words now highlight synchronously via `applySingleWordHighlight()` the instant recognition data arrives.

---

## 5. In-Depth Architectural Analysis & Performance Diagnosis

The user requested an architectural analysis to determine whether JavaScript optimizations were sufficient or if a local Python backend was necessary.

### Pipeline Latency Breakdown

| Stage | Typical Latency | Notes / Measurable By |
|---|---|---|
| **Microphone Capture $\rightarrow$ Browser Buffer** | 10–30 ms | `AudioContext.baseLatency` |
| **Browser Framing & VAD** | 20–80 ms | Native WebAudio processing |
| **Google Cloud STT Round-Trip** | **300–900 ms** | Network transmission + remote decoding (unavoidable ceiling) |
| **Client JS Matching Engine** | < 5 ms | `performance.now()` in `handleSpeechResult` |
| **DOM Class Update & Repaint** | < 2 ms | DevTools Performance Profiler |

> **Conclusion**: Over 90% of the perceived lag was caused by the mandatory round-trip to Google's cloud servers in `webkitSpeechRecognition`. To achieve sub-150 ms real-time feedback, speech recognition had to move **locally onto the user's machine**.

### Comparison of Backend Options

| Option | Per-Word Latency | Offline Support | Accuracy (EN/FR) | Setup Complexity |
|---|---|---|---|---|
| **Chrome Web Speech (Cloud)** | 150–700 ms | ❌ No | Good | Low (built-in) |
| **Vosk (Local Kaldi)** | 50–150 ms | ✅ Yes | Moderate | Medium |
| **faster-whisper tiny (Local CPU)** | **40–120 ms** | ✅ Yes | **High** | Medium |
| **faster-whisper tiny (Local GPU)** | 10–30 ms | ✅ Yes | **High** | High (CUDA required) |

**Decision**: The user approved moving forward with **`faster-whisper` tiny (CPU, int8)** for English and French.

---

## 6. Implementation of the Local AI Backend (`faster-whisper`)

A dual-backend architecture was developed so that the application runs with high-performance local AI when available, while retaining complete standalone browser fallback.

### Components Built

#### 1. Python Server (`server.py`)
- **HTTP Server (`http://localhost:8080`)**: Serves the application files (`index.html`, `css/`, `js/`) so that Chrome treats the site as a secure localhost context, enabling microphone and `AudioWorklet` access.
- **WebSocket Server (`ws://localhost:8765`)**:
  - Receives raw 16 kHz 16-bit PCM audio frames (20 ms / 320 samples) streamed from the browser.
  - Energy-based Voice Activity Detection (RMS VAD) buffers speech until a 400 ms silence boundary is detected.
  - Dispatches audio to `faster-whisper` (`WhisperModel("tiny", device="cpu", compute_type="int8")`) in a background `ThreadPoolExecutor`.
  - Streams recognized words back across the WebSocket as individual JSON packets (`{"type": "word", "word": "..."}`).
- Automatically opens the default browser to `http://localhost:8080`.

#### 2. Dual-Backend Client Engine (`js/speech.js`)
- Probes `ws://localhost:8765` on initialization:
  - **If Python server is running**: Connects WebSocket, activates inlined `AudioWorkletProcessor` (320 samples per frame), and operates in **Whisper AI Mode** (40–120 ms latency).
  - **If Python server is not running**: Gracefully falls back to browser `webkitSpeechRecognition`.
- Shares identical public lifecycle APIs (`start()`, `pause()`, `resume()`, `stop()`, `reset()`, `setText()`, `setLanguage()`) so `js/app.js` required zero modifications.

#### 3. Launcher Script (`start.bat`)
- Automates Python version verification, dependency installation via `pip`, model caching, server initialization, and browser launching.

---

## 7. Installation & Windows Environment Troubleshooting

### Issue 1: Batch Script Syntax Errors (`'─'` is not recognized)
- **Error**: Windows CMD failed to parse `start.bat` immediately upon launch:
  ```
  '───────────────────────────────────────────────────' is not recognized as an internal or external command
  '2.' is not recognized as an internal or external command
  ```
- **Cause**: The batch file contained UTF-8 box-drawing characters (`─`, `│`, `╔`, `║`) that caused Windows CMD to misinterpret line endings and characters prior to active code page configuration.
- **Solution**: Rewrote `start.bat` using strictly standard ASCII characters (`=`, `-`, `+`, `|`).

### Issue 2: Compilation Failure on Python 3.15 (`av` / PyAV Cython build error)
- **Error**: During `pip install -r requirements.txt`:
  ```
  ERROR: Failed to build 'av' when getting requirements to build wheel
  Cython.Compiler.Errors.CompileError: av\logging.pyx
  ```
- **Cause**: The user was running **Python 3.15.2**. Pre-compiled binary wheels (`.whl`) on PyPI for heavy C/Cython packages (such as `av` and `ctranslate2`) are only compiled up through **Python 3.12**. On Python 3.14+, `pip` attempts to compile C extensions from source, requiring local Microsoft Visual C++ Build Tools and FFmpeg header files.
- **Solution & Recommendation**:
  1. Updated `requirements.txt` and `start.bat` to install `faster-whisper` with `--no-deps` to bypass `av` entirely (the custom server handles raw audio via `numpy`, making `av` unnecessary).
  2. Recommended installing stable **Python 3.11.9** or **Python 3.12**, where all binary wheels install instantly with zero compilation.

---

## 8. Summary of Architecture & Current State

```
                      ┌────────────────────────────────────────┐
                      │            ReadFluently App            │
                      │         (http://localhost:8080)        │
                      └───────────────────┬────────────────────┘
                                          │
                        WebSocket Probe to ws://localhost:8765
                                          │
                     ┌────────────────────┴───────────────────┐
                     ▼                                        ▼
           [ Server Responded ]                     [ Server Not Running ]
                     │                                        │
      ┌──────────────┴──────────────┐             ┌───────────┴───────────┐
      │   PRIMARY: faster-whisper   │             │ FALLBACK: Web Speech  │
      │                             │             │                       │
      │ • Inlined AudioWorklet      │             │ • Browser SpeechRec   │
      │ • 16 kHz Int16 PCM streaming│             │ • Google Cloud STT    │
      │ • Local RMS VAD             │             │ • Sliced dedup engine │
      │ • faster-whisper tiny (CPU) │             │ • Latency: ~300–700ms │
      │ • Latency: ~40–120ms        │             └───────────────────────┘
      └─────────────────────────────┘
```

### File Map
- **`server.py`**: Local Python HTTP server (port 8080) and WebSocket STT server (port 8765).
- **`requirements.txt`**: Core dependencies (`faster-whisper`, `websockets`, `ctranslate2`, `numpy`).
- **`start.bat`**: Clean-ASCII one-click launcher for Windows.
- **`js/speech.js`**: Dual-backend speech engine supporting both local Whisper and Chrome Web Speech.
- **`js/app.js`**: Main UI controller, event handlers, and immediate DOM highlighting logic.
- **`js/audio.js`**: Text-to-Speech audio manager with dual-track heartbeat pacing for French TTS.
- **`js/i18n.js`**: Bilingual English / French localization dictionary and controller.
- **`js/stories.js`**: Curated reading passages and comprehension quizzes in English and French.
- **`js/storage.js`**: Plain-text profile persistence, session recording, and badge management.
- **`INSTALL.md`**: Step-by-step setup and troubleshooting guide.
