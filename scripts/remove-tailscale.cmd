@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-tailscale.ps1" %*
echo.
pause >nul
