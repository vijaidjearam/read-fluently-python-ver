@echo off
setlocal
 title ReadFluently - AI Speech Server
cd /d "%~dp0"

 echo.
 echo  =====================================================
 echo   ReadFluently -- faster-whisper AI Speech Server
 echo   Low-latency EN/FR reading trainer (CPU mode)
 echo  =====================================================
 echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python was not found in PATH.
    echo Install Python 3.10-3.13 from https://www.python.org/downloads/
    echo Ensure "Add Python to PATH" is enabled, then reopen this window.
    echo.
    pause
    exit /b 1
)

python --version
if errorlevel 1 (
    echo [ERROR] Could not run Python.
    pause
    exit /b 1
)

echo.
echo [INFO] Installing server and speech-recognition dependencies.
echo        This includes PyAV (required by faster-whisper) and onnxruntime (required for VAD).
echo.
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed. The pip error above is important.
    echo Check your internet connection and Python version, then try again.
    echo Python 3.12 is a good fallback if a package wheel is unavailable.
    echo.
    pause
    exit /b 1
)

echo.
echo [INFO] Checking required Python imports...
python -c "import faster_whisper, av, onnxruntime, websockets, numpy; print('All required imports are available.')"
if errorlevel 1 (
    echo.
    echo [ERROR] A required module still cannot be imported. See the traceback above.
    echo.
    pause
    exit /b 1
)

echo.
echo [INFO] Starting ReadFluently AI server...
echo        The first run downloads the Whisper model; progress/heartbeat is shown below.
echo        Browser URL: http://localhost:8080
 echo       Press Ctrl+C here to stop the server.
echo.
python -u server.py
set SERVER_EXIT=%ERRORLEVEL%
if not "%SERVER_EXIT%"=="0" (
    echo.
    echo [ERROR] Server exited with code %SERVER_EXIT%. Review the traceback above.
) else (
    echo.
    echo [INFO] Server stopped.
)
echo.
pause
exit /b %SERVER_EXIT%
