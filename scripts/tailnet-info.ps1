# 打印「在外面该用哪个地址」，并把该做的检查一次做完。
#
# 用法：pwsh scripts/tailnet-info.ps1
#
# 它回答三个问题：
#   1. 这台电脑上 tailnet 了吗（有没有 100.x 地址）
#   2. 手机该填什么地址
#   3. 插件在这个地址上到底答不答（答不上就是插件/防火墙的问题，不是网络的）
param([int]$Port = 3081, [string]$PairFile = "$env:USERPROFILE\.dsh\pocket.json")

$ErrorActionPreference = "Continue"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
    Write-Host "电脑上还没装 Tailscale：winget install --id Tailscale.Tailscale" -ForegroundColor Red
    exit 1
}

$state = "unknown"
$addresses = @()

# tailscale status --json 在未登录时会一直等，所以给个超时
$job = Start-Job { & "C:\Program Files\Tailscale\tailscale.exe" status --json }
if (Wait-Job $job -Timeout 12) {
    $raw = Receive-Job $job
    try {
        $json = $raw | ConvertFrom-Json
        $state = $json.BackendState
        if ($json.Self) { $addresses = $json.Self.TailscaleIPs }
    } catch { }
} else {
    $state = "（后端没响应，通常是还没登录）"
}
Remove-Job $job -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Tailscale 状态: $state" -ForegroundColor Cyan
if ($addresses.Count -eq 0) {
    Write-Host "这台电脑还没有 tailnet 地址。" -ForegroundColor Yellow
    Write-Host "→ 点右下角托盘里的 Tailscale 图标 → Log in… → 浏览器里用你的账号登录" -ForegroundColor Yellow
    Write-Host "→ 登录完再跑一次这个脚本" -ForegroundColor Yellow
    exit 2
}

$ip = $addresses | Where-Object { $_ -like '100.*' } | Select-Object -First 1
Write-Host "本机 tailnet 地址: $ip" -ForegroundColor Green
Write-Host "手机在「外面」时填: http://${ip}:$Port/__pocket__/" -ForegroundColor Green

# 插件在 tailnet 地址上答不答
try {
    $health = Invoke-RestMethod -Uri "http://${ip}:$Port/__pocket__/health" -TimeoutSec 5
    Write-Host "插件在这个地址上: 正常（上游 $($health.upstream.port) $($health.upstream.ready)）" -ForegroundColor Green
} catch {
    Write-Host "插件在这个地址上没应答：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  · dsh web 起着吗？插件装了吗？" -ForegroundColor DarkGray
    Write-Host "  · 防火墙放行了吗？（netsh advfirewall firewall add rule name=`"dsh-pocket`" dir=in action=allow protocol=TCP localport=$Port）" -ForegroundColor DarkGray
}

if (Test-Path $PairFile) {
    $code = (Get-Content $PairFile -Raw | ConvertFrom-Json).code
    Write-Host "配对码: $code" -ForegroundColor Green
}