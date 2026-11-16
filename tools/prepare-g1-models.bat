@echo off
REM builder3 v30 — ONE-DOUBLE-CLICK owner step. Creates g1-models-transfer.zip
REM (all local-export models + owner-computed SHA-256 manifest) in the project root.
REM Uploads NOTHING. Run from anywhere — paths are resolved from the repo root.
REM
REM OPTIONAL (Oromo TTS, once, before double-clicking — in the Amharic export venv):
REM   python tools\export-orm-tts.py --orm-dir facebook--mms-tts-orm --out research\onnx-export-20261111
setlocal
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\package-g1-models.ps1"
if errorlevel 1 (
  echo.
  echo Packaging FAILED - read the red messages above.
  pause
  exit /b 1
)
echo.
echo DONE: g1-models-transfer.zip was created in the project root.
echo Next: send the zip to your phone by your own private channel (e.g. a message
echo to yourself), open the G1 app, choose "Model Import" - "Transfer Package",
echo and pick the zip. The app verifies every file (SHA-256) and stages all models.
pause
