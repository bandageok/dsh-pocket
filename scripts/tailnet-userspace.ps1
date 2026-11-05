# 用 userspace 模式跑 Tailscale（绕开这台 Windows 上起不来的服务后端）
#
# 背景：这台机器上 `tailscaled` 作为服务启动时，会在
#     creating dns cleanup: Invalid class string
# 处失败并退出，托盘报 "Failed connecting to the Tailscale service"，
# `tailscale status` 则是 503 no backend。卸载重装无效（COM 组件坏了，不是安装问题）。
#
# 但同一个二进制用 **userspace 模式**（不创建 TUN、不动系统 DNS）能稳定跑起来 ——
# 代价是电脑没有虚拟网卡，别的机器不能直接连 100.x，所以要用 `tailscale serve`
# 把本机端口发布到 tailnet 上（serve 在 tailscaled 内部做代理，不需要 TUN）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailnet-userspace.ps1
#   ... -Install      注册登录自启的计划任务（掉线重连、开机自启）
#   ... -Serve        跑起来后把 3081 发布出去
#   ... -Status       只看状态
param(
    [switch]$Install,
    [switch]$Serve,
    [switch]$Status,
    [int]$Port = 3081,
    [string]$PipeName = "dshpocket-tailnet"
)

$ErrorActionPreference = "Continue"
$tsExe = "C:\Program Files\Tailscale\tailscale.exe"
$tsdExe = "C:\Program Files\Tailscale\tailscaled.exe"
$stateDir = "$env:LOCALAPPDATA\DshPocket\tsnet"
$stateFile = Join-Path $stateDir "tailscaled.state"
$pipePath = '\\.\pipe\' + $PipeName

if (-not (Test-Path $tsExe)) {
    Write-Host "没装 Tailscale：winget install --id Tailscale.Tailscale" -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# 用 .cmd 传参：PowerShell 的 -ArgumentList 会把 \\.\pipe 里的反斜杠吃掉一个，
# 而 .cmd 是 CreateProcess 直传，不做任何转义处理。
function Write-Launcher {
    $cmd = Join-Path $stateDir "start-daemon.cmd"
    $line = '@echo off' + "`r`n" +
        '"' + $tsdExe + '" --windows-mode=dev --tun=userspace-networking --state="' + $stateFile + '" --socket=' + $pipePath + ' --port=41651' + "`r`n"
    Set-Content -Path $cmd -Value $line -Encoding ASCII
    return $cmd
}

function Invoke-Ts {
    param([string[]]$args2, [int]$timeoutSec = 15)
    $job = Start-Job -ScriptBlock {
        param($exe, $sock, $a)
        & $exe --socket=$sock @a 2>&1
    } -ArgumentList $tsExe, $pipePath, $args2
    $done = Wait-Job $job -Timeout $timeoutSec
    $out = if ($done) { Receive-Job $job } else { $null }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return ($out | Out-String).Trim()
}

if ($Status) {
    Write-Host (Invoke-Ts @("status"))
    exit 0
}

Write-Host "`n[1/4] 起 userspace daemon" -ForegroundColor Cyan
$already = Invoke-Ts @("status") 6
if ($already -match 'Logged (out|in)|100\.') {
    Write-Host "  已有实例在跑" -ForegroundColor DarkGray
} else {
    $launcher = Write-Launcher
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$launcher`"") -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 6
    $check = Invoke-Ts @("status") 8
    if (-not ($check -match 'Logged|100\.')) {
        Write-Host "  daemon 没起来。手动看：$stateDir\start-daemon.cmd" -ForegroundColor Red
        exit 2
    }
}
Write-Host "  ok" -ForegroundColor Green

Write-Host "`n[2/4] 登录状态" -ForegroundColor Cyan
$st = Invoke-Ts @("status") 10
Write-Host ($st -split "`n" | Select-Object -First 4 | Out-String)

if ($st -match 'Logged out') {
    Write-Host "[3/4] 需要登录：打开浏览器里的授权链接" -ForegroundColor Yellow
    $job = Start-Job -ScriptBlock {
        param($exe, $sock) & $exe --socket=$sock up --accept-routes 2>&1
    } -ArgumentList $tsExe, $pipePath
    $url = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        $log = Get-ChildItem "$env:LOCALAPPDATA\Tailscale\Logs" -Filter *.txt -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($log) {
            $hit = Select-String -Path $log.FullName -Pattern 'https://login\.tailscale\.com/a/[A-Za-z0-9]+' -ErrorAction SilentlyContinue |
                Select-Object -Last 1
            if ($hit) { $url = $hit.Matches[0].Value; break }
        }
    }
    if ($url) {
        Write-Host "  授权链接：$url" -ForegroundColor Green
        Start-Process $url
        Write-Host "  → 在浏览器里完成登录（账号要和你手机端同一个）" -ForegroundColor Green
    } else {
        Write-Host "  没拿到链接：托盘 → Log in…，或再跑一次本脚本" -ForegroundColor Yellow
    }
    Write-Host "  登录完再跑一次本脚本（加 -Serve）即可。" -ForegroundColor Yellow
    exit 3
}

$self = (Invoke-Ts @("status", "--json") 10 | ConvertFrom-Json)
$ip = ($self.Self.TailscaleIPs | Where-Object { $_ -like '100.*' } | Select-Object -First 1)

if ($Serve) {
    Write-Host "`n[3/4] 把本机 $Port 发布到 tailnet（serve）" -ForegroundColor Cyan
    $null = Invoke-Ts @("serve", "--bg", "$Port") 20
    Write-Host (Invoke-Ts @("serve", "status") 10)
}

Write-Host "`n[4/4] 结果" -ForegroundColor Cyan
$dns = $self.Self.DNSName
Write-Host "  电脑 tailnet 地址：$ip" -ForegroundColor Green
if ($dns) { Write-Host "  MagicDNS 名：$($dns.TrimEnd('.'))" -ForegroundColor Green }
if ($Serve) {
    Write-Host "  手机请填：https://$($dns.TrimEnd('.'))/__pocket__/" -ForegroundColor Green
} else {
    Write-Host "  手机可填：http://${ip}:$Port/__pocket__/（userspace 模式下需要先 -Serve）" -ForegroundColor Yellow
}

if ($Install) {
    Write-Host "`n[附加] 注册登录自启计划任务" -ForegroundColor Cyan
    $launcher = Write-Launcher
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcher`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "DshPocket-Tailnet" -Action $action -Trigger $trigger -Force | Out-Null
    Write-Host "  已注册：DshPocket-Tailnet（登录时启动）" -ForegroundColor Green
}