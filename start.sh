#!/usr/bin/env bash
set -Eeuo pipefail

# Run from this script's directory, regardless of the caller's working directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"

printf '\n'
printf ' =====================================================\n'
printf '  ReadFluently -- faster-whisper AI Speech Server\n'
printf '  Low-latency EN/FR reading trainer (CPU mode)\n'
printf ' =====================================================\n\n'

if ! command -v python3 >/dev/null 2>&1; then
    printf '[ERROR] python3 was not found in PATH.\n' >&2
    printf 'Install it with: sudo apt update && sudo apt install python3 python3-venv python3-pip\n' >&2
    exit 1
fi

if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'; then
    printf '[ERROR] Python 3.9 or newer is required; found: ' >&2
    python3 --version >&2 || true
    printf 'Install a supported Python 3 release (including python3-venv and python3-pip), then retry.\n' >&2
    exit 1
fi
python3 --version

VENV_DIR="$SCRIPT_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
if [[ ! -x "$VENV_PYTHON" ]]; then
    printf '\n[INFO] Creating project-local Python virtual environment at .venv.\n'
    if ! python3 -m venv "$VENV_DIR"; then
        printf '[ERROR] Could not create .venv. On Ubuntu/Linux Mint, install venv support with:\n' >&2
        printf '        sudo apt install python3-venv python3-pip\n' >&2
        exit 1
    fi
fi

printf '\n[INFO] Installing server and speech-recognition dependencies.\n'
printf '       This includes PyAV (required by faster-whisper) and onnxruntime (required for VAD).\n\n'
if ! "$VENV_PYTHON" -m pip install -r requirements.txt; then
    printf '\n[ERROR] Dependency installation failed. The pip error above is important.\n' >&2
    printf 'Check your internet connection, Python version, and requirements.txt, then try again.\n' >&2
    exit 1
fi

printf '\n[INFO] Checking required Python imports...\n'
if ! "$VENV_PYTHON" -c 'import faster_whisper, av, onnxruntime, websockets, numpy; print("All required imports are available.")'; then
    printf '\n[ERROR] A required module still cannot be imported. See the traceback above.\n' >&2
    exit 1
fi

printf '\n[INFO] Starting ReadFluently AI server...\n'
printf '       The first run downloads the Whisper model; progress/heartbeat is shown below.\n'
printf '       Browser URL: http://localhost:8080\n'
printf '       The server opens the browser automatically when possible.\n'
printf '       Press Ctrl+C here to stop the server.\n\n'

if "$VENV_PYTHON" -u server.py; then
    printf '\n[INFO] Server stopped.\n'
else
    server_status=$?
    printf '\n[ERROR] Server exited with code %s. Review the traceback above.\n' "$server_status" >&2
    exit "$server_status"
fi
