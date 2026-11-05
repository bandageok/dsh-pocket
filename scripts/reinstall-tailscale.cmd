@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reinstall-tailscale.ps1" %*
echo.
pause >nul
