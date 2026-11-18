@echo off
setlocal
chcp 65001 >nul
title QQ-bot launcher
cd /d "%~dp0"

echo.
echo   QQ-bot launcher
echo   ------------------------------------------------------------
echo   checks QQ, rebinds the bot instance, un-trays the window,
echo   starts the bot, then runs a health check.
echo   ------------------------------------------------------------
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\recover.ps1" -RestoreWindow
set RC=%ERRORLEVEL%

if %RC% GEQ 2 goto failed

echo.
echo   Console: http://127.0.0.1:8787
start "" "http://127.0.0.1:8787"
echo   Bot runs in the background. This window can be closed.
echo.
pause
exit /b 0

:failed
echo.
echo   [FATAL] Startup failed.
echo   Most likely QQ is not running, or the running QQ instance is not
echo   logged in with the BOT account.
echo   Log in the bot account, then run this file again.
echo.
echo   Detail: data\bot-stdout.log
pause
exit /b 2
