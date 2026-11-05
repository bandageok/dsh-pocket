# 修复并登录电脑端 Tailscale（会自己提权，双击即可）
#
# 为什么需要它：这台机器上 tailscaled 起不来 —— 服务在跑，但从不创建 IPC 命名管道，
# 于是 `tailscale` 任何命令都连不上，托盘的「Log in」也就点了没反应。日志里的第一行提示是：
#     winhttp: Open: The parameter is incorrect.
#     tshttpproxy: winhttp: GetProxyForURL("https://controlplane.tailscale.com/"): ERROR_INVALID_PARAMETER
#     creating dns cleanup: Invalid class string
# 重启服务需要管理员权限，所以这个脚本先自我提权，再做下面这些事：
#   1. 重启 Tailscale 服务，等它真的把管道建起来
#   2. 调 `tailscale login` 拿授权链接
#   3. 用默认浏览器打开，你在里面登录
#   4. 登录完打印 tailnet 地址，并验证插件在 100.x 上能不能响应
#
# 用法：
#   pwsh scripts/fix-tailscale.ps1          # 自动提权
#   pwsh scripts/fix-tailscale.ps1 -NoElevate   # 已经用管理员窗口跑的时候
param(
    [switch]$NoElevate,
    [int]$Port = 3081
)

$ErrorActionPreference = "Continue"
$tsDir = "C:\Program Files\Tailscale"
$ts = Join-Path $tsDir "tailscale.exe"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin) -and -not $NoElevate) {
    Write-Host "需要管理员权限，正在提权（UAC 里点“是”）…" -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"", "-NoElevate"
    ) | Out-Null
    exit
}

if (-not (Test-Path $ts)) {
    Write-Host "没装 Tailscale：winget install --id Tailscale.Tailscale" -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/4] 重启 Tailscale 服务并等管道就绪" -ForegroundColor Cyan
Restart-Service Tailscale -Force -ErrorAction SilentlyContinue
$pipeName = '\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled'
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $pipes = [System.IO.Directory]::GetFiles('\\.\pipe\')
    if ($pipes | Where-Object { $_ -match 'tailscale' }) { $ready = $true; break }
}
if (-not $ready) {
    Write-Host "服务起来了但管道仍然没有 —— 这台机器需要重启一次（Tailscale 服务状态已经坏掉）。" -ForegroundColor Red
    Write-Host "重启后直接再跑本脚本即可。" -ForegroundColor Yellow
    exit 2
}
Write-Host "管道就绪。" -ForegroundColor Green

Write-Host "`n[2/4] 取授权链接并打开浏览器" -ForegroundColor Cyan
$job = Start-Job -ScriptBlock {
    param($exe) & $exe login --accept-routes --hostname=dsh-pc 2>&1
} -ArgumentList $ts

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $state = & $ts status --json 2>$null
    if ($state) {
        try {
            $json = $state | ConvertFrom-Json
            if ($json.AuthURL) { $url = $json.AuthURL; break }
        } catch { }
    }
}
if (-not $url) {
    Write-Host "没拿到授权链接。手动来：托盘图标 → Log in…" -ForegroundColor Yellow
} else {
    Write-Host "授权链接：$url" -ForegroundColor Green
    Start-Process $url
}
Remove-Job $job -Force -ErrorAction SilentlyContinue

Write-Host "`n[3/4] 等你在浏览器里完成登录（最多 3 分钟）" -ForegroundColor Cyan
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    $s = & $ts status 2>$null
    if ($s -and ($s -join "`n") -match '100\.') { break }
}
$status = & $ts status 2>$null
if (-not ($status -and ($status -join "`n") -match '100\.')) {
    Write-Host "还没登录成功。浏览器里登录完再跑一次本脚本的 [4/4] 部分是安全的。" -ForegroundColor Yellow
    exit 3
}
$status | Write-Host

Write-Host "`n[4/4] 验证插件在 tailnet 地址上可用" -ForegroundColor Cyan
$ip = (& $ts status --json 2>$null | ConvertFrom-Json).Self.TailscaleIPs |
    Where-Object { $_ -like '100.*' } | Select-Object -First 1
if ($ip) {
    Write-Host "电脑 tailnet 地址：$ip" -ForegroundColor Green
    Write-Host "手机在“外面”时填：http://${ip}:$Port/__pocket__/" -ForegroundColor Green
    try {
        $h = Invoke-RestMethod "http://${ip}:$Port/__pocket__/health" -TimeoutSec 5
        Write-Host "插件应答正常（上游 $($h.upstream.port)，ready=$($h.upstream.ready)）" -ForegroundColor Green
    } catch {
        Write-Host "插件在这个地址上没有应答：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  → dsh web 起着吗？插件装了吗？" -ForegroundColor DarkGray
    }
}
Write-Host "`n完成。手机端已登录的话，点一次「启动隧道」它会自动找到这台电脑。" -ForegroundColor Green