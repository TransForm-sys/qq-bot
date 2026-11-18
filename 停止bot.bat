@echo off
setlocal
chcp 65001 >nul
title QQ-bot stop
cd /d "%~dp0"

echo.
echo   Stopping the bot process (QQ stays logged in)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-bot.ps1"
set RC=%ERRORLEVEL%

echo.
if %RC% EQU 0 echo   Done.
if not %RC% EQU 0 echo   Something is still running - check the lines above.
echo.
pause
exit /b %RC%
