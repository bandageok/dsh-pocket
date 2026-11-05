@echo off
REM 双击我：修电脑端 Tailscale 并登录。
REM 之所以有这个 .cmd：Windows 自带的是 PowerShell 5.1，没有 pwsh；而且从资源管理器
REM 双击 .ps1 默认会被执行策略拦住。这里统一用 5.1 + Bypass，脚本内部再自己提权。
setlocal
set SCRIPT=%~dp0fix-tailscale.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
echo.
echo 窗口保留着，方便看输出。按任意键关闭。
pause >nul