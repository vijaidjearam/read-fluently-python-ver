/**
 * ReadFluently — Speech Recognition Engine  (v3 — Dual Backend)
 * ==============================================================
 *
 * PRIMARY   → faster-whisper (local Python server on ws://localhost:8765)
 *             AudioWorklet mic → 20 ms Int16 PCM frames → WebSocket → Python
 *             → word tokens streamed back → matched → highlighted
 *             Expected per-word latency: 40–120 ms on a modern CPU
 *
 * FALLBACK  → Chrome Web Speech API (webkitSpeechRecognition)
 *             Used automatically when the Python server is not running.
 *             Expected per-word latency: 150–500 ms (Chrome cloud round-trip)
 *
 * Public API (identical for both backends — app.js does not need changes):
 *   setText(text)        → tokenise, returns token array
 *   start()              → begin listening
 *   pause() / resume()   → pause/resume
 *   stop()               → stop completely
 *   reset()              → full reset
 *   setLanguage(lang)    → 'en' or 'fr'
 *   advanceToWord(index) → tap-to-advance fallback
 *
 *   onWordMatched(index, token, wpm)
 *   onProgress(currentIndex, total, wpm, pct)
 *   onStatusChange(status, message)
 *   onFinished(summary)
 */

class ReadingSpeechEngine {
    constructor() {

        // ── Whisper / WebSocket backend ────────────────────────────────────
        this._whisperAvailable = false;  // set true after successful probe
        this._ws              = null;    // active WebSocket
        this._audioCtx        = null;    // AudioContext (16 kHz)
        this._workletNode     = null;    // AudioWorkletNode
        this._micStream       = null;    // MediaStream from getUserMedia
        this._usingWhisper    = false;   // true while actively streaming to Whisper

        // ── Web Speech API (fallback) ──────────────────────────────────────
        this.recognition  = null;
        this.isSupported  = false;

        // ── Shared reading state ───────────────────────────────────────────
        this.isListening  = false;
        this.isPaused     = false;
        this.currentLang  = 'en';
        this.recognitionLang = 'en-US';

        this.tokens       = [];
        this.currentIndex = 0;
        this.matchedCount = 0;
        this.missedWords  = [];

        // ── WPM tracking ───────────────────────────────────────────────────
        this.startTime         = null;
        this.activeDurationMs  = 0;
        this.lastSpeechTimestamp = null;
        this.wpmTimer          = null;
        this.currentWpm        = 0;

        // Web Speech deduplication counters (not used in Whisper mode)
        this._processedWordCount = 0;
        this._lastResultIndex    = 0;

        // ── Callbacks (assigned by app.js setupSpeechCallbacks) ───────────
        this.onWordMatched  = null;
        this.onProgress     = null;
        this.onStatusChange = null;
        this.onFinished     = null;

        // Probe Whisper server; initialise Web Speech in parallel
        this._probeWhisperServer();
        this._initWebSpeech();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  LANGUAGE
    // ════════════════════════════════════════════════════════════════════════

    setLanguage(lang) {
        this.currentLang     = lang;
        this.recognitionLang = lang === 'fr' ? 'fr-FR' : 'en-US';
        if (this.recognition) this.recognition.lang = this.recognitionLang;
        // Inform the Python server so it passes the right language to Whisper
        this._wsSend({ type: 'language', lang });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  WHISPER BACKEND — probe + audio pipeline
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Non-blocking probe: open a WebSocket, see if the server answers.
     * Result sets this._whisperAvailable so start() knows which path to use.
     */
    _probeWhisperServer() {
        try {
            const probe = new WebSocket('ws://localhost:8765');
            const timer = setTimeout(() => probe.close(), 2500);

            probe.onopen = () => {
                clearTimeout(timer);
                probe.close();
                this._whisperAvailable = true;
                console.log('[ReadFluently] ✅ faster-whisper server detected on :8765');
                const msg = this.currentLang === 'fr'
                    ? '🤖 Mode IA Whisper actif — latence ultra-faible !'
                    : '🤖 Whisper AI mode active — ultra-low latency!';
                if (this.onStatusChange) this.onStatusChange('whisper-ready', msg);
            };
            probe.onerror = () => {
                clearTimeout(timer);
                this._whisperAvailable = false;
                console.log('[ReadFluently] ℹ️  No Whisper server — using Chrome Web Speech API');
            };
            probe.onclose = () => clearTimeout(timer);
        } catch (_) {
            this._whisperAvailable = false;
        }
    }

    /** Open (or reuse) the persistent WebSocket connection to Python server. */
    _openWebSocket() {
        return new Promise((resolve, reject) => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                resolve(); return;
            }
            const ws = new WebSocket('ws://localhost:8765');
            const timer = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 4000);

            ws.onopen = () => {
                clearTimeout(timer);
                this._ws = ws;
                ws.onmessage = (e) => this._handleWhisperMessage(e);
                ws.onerror   = (e) => console.error('[Whisper WS] error:', e);
                ws.onclose   = ()  => {
                    this._ws = null;
                    this._usingWhisper = false;
                    if (this.isListening && !this.isPaused) {
                        console.warn('[ReadFluently] WebSocket closed — falling back to Web Speech');
                        this._startWebSpeech();
                    }
                };
                resolve();
            };
            ws.onerror = () => {
                clearTimeout(timer);
                this._whisperAvailable = false;
                reject(new Error('Cannot connect to ws://localhost:8765'));
            };
        });
    }

    /**
     * Open the microphone via AudioWorklet at 16 kHz.
     * The AudioWorklet code is inlined as a Blob URL so it works with
     * both http://localhost:8080 (server mode) and file:// (direct open).
     */
    async _openMicWorklet() {
        this._stopMicAudio();   // close any previous capture graph

        // 16 kHz AudioContext — Chrome supports custom sampleRate
        this._audioCtx = new AudioContext({ sampleRate: 16000 });

        // Inline worklet as Blob URL — avoids file:// CORS restrictions
        const WORKLET_SRC = `
class AudioCaptureRF extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = new Float32Array(320); // 20 ms @ 16 kHz
        this._idx = 0;
    }
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
            this._buf[this._idx++] = ch[i];
            if (this._idx === 320) {
                const copy = this._buf.slice();          // transfer ownership
                this.port.postMessage(copy, [copy.buffer]);
                this._buf = new Float32Array(320);
                this._idx = 0;
            }
        }
        return true;   // keep processor alive
    }
}
registerProcessor('audio-capture-rf', AudioCaptureRF);
`;
        const blob    = new Blob([WORKLET_SRC], { type: 'application/javascript' });
        const blobURL = URL.createObjectURL(blob);
        await this._audioCtx.audioWorklet.addModule(blobURL);
        URL.revokeObjectURL(blobURL);

        // Request microphone with settings that suit speech recognition
        this._micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });

        const srcNode = this._audioCtx.createMediaStreamSource(this._micStream);
        this._workletNode = new AudioWorkletNode(this._audioCtx, 'audio-capture-rf');

        // Forward each 20 ms frame to the WebSocket as Int16 PCM
        this._workletNode.port.onmessage = (e) => {
            if (!this.isListening || this.isPaused) return;
            if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

            const f32 = e.data;                          // Float32Array (320 samples)
            const i16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) {
                i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
            }
            this._ws.send(i16.buffer);
        };

        // Connect graph: mic → worklet → silent gain → destination
        // (destination connection keeps the AudioContext running in Chrome)
        const silentGain = this._audioCtx.createGain();
        silentGain.gain.value = 0;
        srcNode.connect(this._workletNode);
        this._workletNode.connect(silentGain);
        silentGain.connect(this._audioCtx.destination);
    }

    _stopMicAudio() {
        if (this._workletNode) {
            try { this._workletNode.disconnect(); } catch (_) {}
            this._workletNode = null;
        }
        if (this._micStream) {
            this._micStream.getTracks().forEach(t => t.stop());
            this._micStream = null;
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (_) {}
            this._audioCtx = null;
        }
    }

    /**
     * Handle a word token sent back from the Python server.
     * One call = one word.  Much simpler than the Web Speech cumulative
     * transcript — no deduplication needed.
     */
    _handleWhisperMessage(event) {
        if (!this.isListening || this.isPaused) return;

        let data;
        try { data = JSON.parse(event.data); } catch (_) { return; }
        if (!data || data.type !== 'word' || !data.word) return;

        this.lastSpeechTimestamp = Date.now();
        const spokenNorm = this.normalizeWord(data.word);
        if (!spokenNorm) return;

        if (this.currentIndex >= this.tokens.length) { this.finishReading(); return; }

        const target0 = this.tokens[this.currentIndex].clean;

        if (this.isWordMatch(spokenNorm, target0)) {
            // ✅ Exact sequential match
            this._advanceOne(this.currentIndex);

        } else if (this.currentIndex + 1 < this.tokens.length) {
            // One-word lookahead — allow skipping a function word
            const target1 = this.tokens[this.currentIndex + 1].clean;
            if (this.isWordMatch(spokenNorm, target1)) {
                this.missedWords.push(this.tokens[this.currentIndex]);
                this.currentIndex++;   // skip over unmatched word
                this._advanceOne(this.currentIndex);
            }
            // If still no match: Whisper may have hallucinated — ignore quietly
        }

        this.updateWpm();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  WEB SPEECH FALLBACK BACKEND
    // ════════════════════════════════════════════════════════════════════════

    _initWebSpeech() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;

        this.recognition = new SpeechRecognition();
        this.recognition.continuous      = true;
        this.recognition.interimResults  = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.lang            = this.recognitionLang;
        this.isSupported = true;

        this.recognition.onstart = () => {
            this.isListening = true;
            const msg = window.i18n ? window.i18n.t('micListening') : 'Microphone is listening…';
            if (this.onStatusChange) this.onStatusChange('listening', msg);
        };

        this.recognition.onresult = (e) => this._handleWebSpeechResult(e);

        this.recognition.onerror = (e) => {
            if (e.error === 'no-speech') return;
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                const msg = window.i18n ? window.i18n.t('mascotError')
                    : 'Microphone permission blocked. Please allow microphone access.';
                if (this.onStatusChange) this.onStatusChange('error', msg);
                this.stop();
            }
        };

        this.recognition.onend = () => {
            if (this.isListening && !this.isPaused && !this._usingWhisper) {
                try { this.recognition.start(); }
                catch (_) {
                    setTimeout(() => {
                        if (this.isListening && !this.isPaused && !this._usingWhisper) {
                            try { this.recognition.start(); } catch (_e) {}
                        }
                    }, 50);
                }
            } else if (!this.isListening) {
                const msg = window.i18n ? window.i18n.t('micReady') : 'Microphone ready';
                if (this.onStatusChange) this.onStatusChange('idle', msg);
            }
        };
    }

    _startWebSpeech() {
        this._usingWhisper = false;
        if (!this.isSupported) {
            if (this.onStatusChange) {
                this.onStatusChange('unsupported',
                    'Speech recognition unavailable. Run start.bat to enable AI mode!');
            }
            return;
        }
        try {
            this.recognition.lang = this.recognitionLang;
            this.recognition.start();
        } catch (_) {}
    }

    /**
     * Web Speech result handler — uses per-segment deduplication
     * (_processedWordCount) so only genuinely new words advance the cursor.
     */
    _handleWebSpeechResult(event) {
        if (!this.isListening || this.isPaused) return;
        this.lastSpeechTimestamp = Date.now();

        let currentTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res[0] && res[0].transcript) {
                currentTranscript += ' ' + res[0].transcript;
            }
        }
        currentTranscript = currentTranscript.trim();
        if (!currentTranscript) return;

        const allRaw = currentTranscript.split(/\s+/).filter(Boolean);
        if (allRaw.length === 0) return;

        // Reset counter when Chrome starts a new utterance segment
        const isNewSegment = event.resultIndex > (this._lastResultIndex || 0);
        if (isNewSegment) {
            this._lastResultIndex    = event.resultIndex;
            this._processedWordCount = 0;
        }

        const newRaw = allRaw.slice(this._processedWordCount || 0);
        if (newRaw.length === 0) return;

        let advanced = false;

        for (let w = 0; w < newRaw.length; w++) {
            if (this.currentIndex >= this.tokens.length) { this.finishReading(); return; }

            const spokenNorm = this.normalizeWord(newRaw[w]);
            if (!spokenNorm) { this._processedWordCount++; continue; }

            const target0 = this.tokens[this.currentIndex].clean;

            if (this.isWordMatch(spokenNorm, target0)) {
                this._advanceOne(this.currentIndex);
                this._processedWordCount++;
                advanced = true;

            } else if (this.currentIndex + 1 < this.tokens.length) {
                const target1 = this.tokens[this.currentIndex + 1].clean;
                if (this.isWordMatch(spokenNorm, target1)) {
                    this.missedWords.push(this.tokens[this.currentIndex]);
                    this.currentIndex++;
                    this._advanceOne(this.currentIndex);
                    this._processedWordCount++;
                    advanced = true;
                } else {
                    this._processedWordCount++;
                }
            } else {
                this._processedWordCount++;
            }
        }

        if (advanced) this.updateWpm();
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PUBLIC LIFECYCLE
    // ════════════════════════════════════════════════════════════════════════

    setText(text) {
        this.reset();
        if (!text) { this.tokens = []; return []; }
        const rawWords = text.trim().split(/\s+/).filter(Boolean);
        this.tokens = rawWords.map((raw, idx) => ({
            index: idx,
            original: raw,
            clean: this.normalizeWord(raw),
            matched: false,
        }));
        return this.tokens;
    }

    start() {
        if (this.tokens.length === 0) return;
        this.isListening  = true;
        this.isPaused     = false;
        this.startTime    = Date.now();
        this.lastSpeechTimestamp = Date.now();
        this.startWpmTimer();

        if (this._whisperAvailable) {
            this._startWithWhisper();
        } else {
            this._startWebSpeech();
        }
    }

    async _startWithWhisper() {
        try {
            await this._openWebSocket();
            this._wsSend({ type: 'language', lang: this.currentLang });
            this._wsSend({ type: 'reset' });
            await this._openMicWorklet();
            this._usingWhisper = true;

            const msg = this.currentLang === 'fr'
                ? '🎙️ IA Whisper à l\'écoute… Lis clairement !'
                : '🎙️ Whisper AI listening… Read clearly!';
            if (this.onStatusChange) this.onStatusChange('listening', msg);

        } catch (err) {
            console.warn('[ReadFluently] Whisper start failed, falling back to Web Speech:', err.message);
            this._whisperAvailable = false;
            this._usingWhisper = false;
            this._startWebSpeech();
        }
    }

    pause() {
        this.isPaused    = true;
        this.isListening = false;
        this.stopWpmTimer();
        this._stopMicAudio();
        if (this.recognition) { try { this.recognition.stop(); } catch (_) {} }
        const msg = window.i18n ? window.i18n.t('micPaused') : 'Paused. Click microphone to resume!';
        if (this.onStatusChange) this.onStatusChange('paused', msg);
    }

    resume() {
        this.isPaused    = false;
        this.isListening = true;
        this.lastSpeechTimestamp = Date.now();
        this.startWpmTimer();

        if (this._whisperAvailable) {
            this._startWithWhisper();
        } else {
            this._startWebSpeech();
        }
    }

    stop() {
        this.isListening   = false;
        this.isPaused      = false;
        this._usingWhisper = false;
        this.stopWpmTimer();
        this._stopMicAudio();
        if (this.recognition) { try { this.recognition.stop(); } catch (_) {} }
    }

    reset() {
        this.stop();
        this.currentIndex    = 0;
        this.matchedCount    = 0;
        this.activeDurationMs = 0;
        this.currentWpm      = 0;
        this.missedWords     = [];
        this.tokens          = [];
        this._processedWordCount = 0;
        this._lastResultIndex    = 0;
        // Tell the Python server to discard its audio buffer
        this._wsSend({ type: 'reset' });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SHARED HELPERS
    // ════════════════════════════════════════════════════════════════════════

    /** Fire the onWordMatched callback and advance the cursor. */
    _advanceOne(index) {
        this.tokens[index].matched = true;
        this.matchedCount++;
        this.currentIndex = index + 1;
        if (this.onWordMatched) this.onWordMatched(index, this.tokens[index], this.currentWpm);
        if (this.currentIndex >= this.tokens.length) this.finishReading();
    }

    /** Tap-to-advance fallback — click a word span to manually advance. */
    advanceToWord(index) {
        if (index < 0 || index >= this.tokens.length) return;
        this.tokens[index].matched = true;
        this.matchedCount++;
        this.currentIndex = index + 1;
        if (this.onWordMatched) this.onWordMatched(index, this.tokens[index], this.currentWpm);
        this.updateWpm();
        if (this.currentIndex >= this.tokens.length) this.finishReading();
    }

    /** Safe WebSocket send — ignores sends when socket is not open. */
    _wsSend(obj) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    startWpmTimer() {
        this.stopWpmTimer();
        this.wpmTimer = setInterval(() => {
            if (this.isListening && !this.isPaused) {
                this.activeDurationMs += 250;
                this.updateWpm();
            }
        }, 250);
    }

    stopWpmTimer() {
        if (this.wpmTimer) { clearInterval(this.wpmTimer); this.wpmTimer = null; }
    }

    updateWpm() {
        if (this.matchedCount === 0 || this.activeDurationMs < 1000) {
            this.currentWpm = 0;
        } else {
            const mins = (this.activeDurationMs / 1000) / 60;
            const raw  = this.matchedCount / mins;
            this.currentWpm = this.matchedCount < 5
                ? Math.min(Math.round(raw), 90)
                : Math.round(raw);
        }
        if (this.onProgress) {
            const pct = this.tokens.length > 0
                ? Math.round((this.currentIndex / this.tokens.length) * 100) : 0;
            this.onProgress(this.currentIndex, this.tokens.length, this.currentWpm, pct);
        }
    }

    // ── Word normalisation ────────────────────────────────────────────────
    normalizeWord(str) {
        if (!str) return '';
        const numMapEn = {
            '0':'zero','1':'one','2':'two','3':'three','4':'four',
            '5':'five','6':'six','7':'seven','8':'eight','9':'nine','10':'ten'
        };
        const numMapFr = {
            '0':'zero','1':'un','2':'deux','3':'trois','4':'quatre',
            '5':'cinq','6':'six','7':'sept','8':'huit','9':'neuf','10':'dix'
        };

        let c = str.toLowerCase();

        // Strip French elision prefixes: l', d', c', j', m', t', s', n', qu'
        if (this.currentLang === 'fr') {
            c = c.replace(/^(l\u2019|d\u2019|c\u2019|j\u2019|m\u2019|t\u2019|s\u2019|n\u2019|qu\u2019|l'|d'|c'|j'|m'|t'|s'|n'|qu')/, '');
        }

        // Decompose accents then strip them (é→e, ç→c, etc.)
        c = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        // Strip non-alphanumeric
        c = c.replace(/[^a-z0-9]/g, '');

        if (this.currentLang === 'fr' && numMapFr[c]) c = numMapFr[c];
        else if (numMapEn[c]) c = numMapEn[c];

        return c;
    }

    // ── Fuzzy word matching ───────────────────────────────────────────────
    isWordMatch(spoken, target) {
        if (!spoken || !target) return false;
        if (spoken === target) return true;

        const s = spoken.toLowerCase().replace(/[^a-z0-9]/g, '');
        const t = target.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!s || !t) return false;
        if (s === t) return true;

        // French article elision: "larbre" matches "arbre", "lune" matches "une"
        if (s === 'l' + t || s === 'd' + t || t === 'l' + s || t === 'd' + s) return true;

        // Prefix match (child may read "jumping" for "jump", etc.)
        if (s.length >= 3 && t.length >= 3 && (s.startsWith(t) || t.startsWith(s))) return true;

        // Levenshtein phonetic tolerance
        const dist = this.levenshtein(s, t);
        if (t.length <= 2) return dist === 0;        // very short words: exact only
        if (t.length <= 3) return dist <= 1;
        if (t.length <= 6) return dist <= (t.length >= 5 ? 2 : 1);
        return dist <= 2;
    }

    levenshtein(a, b) {
        const al = a.length, bl = b.length;
        const m = [];
        for (let i = 0; i <= bl; i++) m[i] = [i];
        for (let j = 0; j <= al; j++) m[0][j] = j;
        for (let i = 1; i <= bl; i++) {
            for (let j = 1; j <= al; j++) {
                m[i][j] = b[i-1] === a[j-1]
                    ? m[i-1][j-1]
                    : Math.min(m[i-1][j-1] + 1, m[i][j-1] + 1, m[i-1][j] + 1);
            }
        }
        return m[bl][al];
    }

    // ── Reading completion ────────────────────────────────────────────────
    finishReading() {
        this.stop();
        const dur    = Math.max(Math.round(this.activeDurationMs / 1000), 1);
        const mins   = dur / 60;
        const summary = {
            totalWords:      this.tokens.length,
            wordsRead:       this.matchedCount,
            durationSeconds: dur,
            wpm:             Math.max(Math.round(this.matchedCount / mins), 10),
            accuracy:        this.tokens.length > 0
                ? Math.min(Math.round((this.matchedCount / this.tokens.length) * 100), 100)
                : 100,
            missedWords: this.missedWords,
        };
        const msg = this.currentLang === 'fr'
            ? "Hourra ! Tu as terminé l'histoire !"
            : 'Hooray! You finished the story!';
        if (this.onStatusChange) this.onStatusChange('finished', msg);
        if (this.onFinished)     this.onFinished(summary);
    }
}

window.ReadingSpeechEngine = ReadingSpeechEngine;
