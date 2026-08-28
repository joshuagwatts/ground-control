@echo off
cd /d "%~dp0"
title Ground Control — Install Lens Vision
echo.
echo  Ground Control — Lens needs a VISION model in Ollama.
echo  This downloads LLaVA (~4 GB). Smaller option: ollama pull moondream
echo.
where ollama >nul 2>&1
if errorlevel 1 (
  echo  Ollama not found. Install from https://ollama.com first, then run this again.
  echo.
  pause
  exit /b 1
)
ollama pull llava
echo.
echo  Done. Restart Control Room.bat, then Re-run Lens on your phone.
echo.
pause
