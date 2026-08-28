@echo off
cd /d "%~dp0"
title Ground Control — Control Room
echo.
echo  Ground Control — Control Room
echo  Keep this window open while your phone is paired.
echo.
npm run control-room
echo.
echo  Control Room stopped.
pause
