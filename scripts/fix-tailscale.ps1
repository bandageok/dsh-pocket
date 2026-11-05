# 修复并登录电脑端 Tailscale（v2：给每个调用加超时，不查“随便哪个管道”）
#
# 背景：这台机器上 tailscaled 起来就死，服务显示 Running 但后端从未就绪 ——
# 托盘的 Log in 点了没反应、`tailscale status` 无输出、`tailscale login` 挂着不动。
# v1 的脚本卡在“取授权链接”，原因是 `tailscale status --json` 在后端未就绪时会**一直等**；
# 而且它把 GUI 的管道误当成守护进程的管道了。
#
# 用法（管理员窗口里，或直接双击 scripts\fix-tailscale.cmd）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-tailscale.ps1 -NoElevate
param(
    [switch]$NoElevate,
    [int]$Port = 3081,
    [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Continue"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
$daemonPipe = '\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled'
$svcLogDir = "C:\Windows\System32\config\systemprofile\AppData\Local\Tailscale\Logs"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin) -and -not $NoElevate) {
    Write-Host "需要管理员，正在提权（UAC 里点“是”）…" -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-NoElevate"
    ) | Out-Null
    exit
}

if (-not (Test-Path $ts)) {
    Write-Host "没装 Tailscale：winget install --id Tailscale.Tailscale" -ForegroundColor Red
    exit 1
}

# 带超时地跑 tailscale 命令：后端没起来时 CLI 会无限等，必须能止损
function Invoke-Ts([string[]]$tsArgs, [int]$timeoutSec = 8) {
    $job = Start-Job -ScriptBlock {
        param($exe, $a) & $exe @a 2>&1
    } -ArgumentList $ts, $tsArgs
    $done = Wait-Job $job -Timeout $timeoutSec
    $out = if ($done) { Receive-Job $job } else { $null }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return ($out | Out-String).Trim()
}

Write-Host "`n[1/4] 重启服务并等**守护进程**的管道" -ForegroundColor Cyan
Restart-Service Tailscale -Force -ErrorAction SilentlyContinue
$up = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $daemonPipe) { $up = $true; break }
}

if (-not $up) {
    Write-Host "守护进程的管道始终没出现 —— tailscaled 起不来。" -ForegroundColor Red
    $log = Get-ChildItem $svcLogDir -Filter *.txt -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
        Write-Host "`n最后 15 行服务日志（$($log.Name)）：" -ForegroundColor Yellow
        Get-Content $log.FullName -Tail 15 | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "（读不到服务日志：$svcLogDir）" -ForegroundColor DarkGray
    }
    Write-Host "`n结论：这台机器需要**重启一次**，开机后立刻再跑本脚本。" -ForegroundColor Yellow
    Write-Host "如果重启后仍是这样，把上面那段日志发我。" -ForegroundColor Yellow
    exit 2
}
Write-Host "守护进程就绪。" -ForegroundColor Green

Write-Host "`n[2/4] 触发登录并取授权链接" -ForegroundColor Cyan
Start-Job -ScriptBlock { param($exe) & $exe login --accept-routes --hostname=dsh-pc 2>&1 } -ArgumentList $ts | Out-Null

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $json = Invoke-Ts @("status", "--json") 6
    if ($json -match '"AuthURL"\s*:\s*"([^"]+)"') { $url = $Matches[1]; break }
    $log = Get-ChildItem $svcLogDir -Filter *.txt -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
        $hit = Select-String -Path $log.FullName -Pattern 'https://login\.tailscale\.com/a/[A-Za-z0-9]+' -ErrorAction SilentlyContinue |
            Select-Object -Last 1
        if ($hit) { $url = $hit.Matches[0].Value; break }
    }
}

if ($url) {
    Write-Host "授权链接：$url" -ForegroundColor Green
    Write-Host "已在浏览器打开，去里面登录。" -ForegroundColor Green
    Start-Process $url
} else {
    Write-Host "自动取链接失败。手动来：右下角托盘 Tailscale 图标 → Log in…" -ForegroundColor Yellow
}

Write-Host "`n[3/4] 等你登录（最多 $WaitSeconds 秒）" -ForegroundColor Cyan
$ip = $null
for ($i = 0; $i -lt [math]::Ceiling($WaitSeconds / 3); $i++) {
    Start-Sleep -Seconds 3
    $json = Invoke-Ts @("status", "--json") 6
    if ($json -match '"TailscaleIPs"\s*:\s*\[\s*"(100\.[0-9.]+)"') { $ip = $Matches[1]; break }
}
if (-not $ip) {
    Write-Host "还没登录成功。浏览器里登录完，再跑一次本脚本即可（安全、幂等）。" -ForegroundColor Yellow
    exit 3
}

Write-Host "`n[4/4] 验证插件在 tailnet 上可用" -ForegroundColor Cyan
Write-Host "电脑 tailnet 地址：$ip" -ForegroundColor Green
Write-Host "手机在“外面”时填：http://${ip}:$Port/__pocket__/" -ForegroundColor Green
try {
    $h = Invoke-RestMethod "http://${ip}:$Port/__pocket__/health" -TimeoutSec 5
    Write-Host "插件应答正常（上游 $($h.upstream.port)，ready=$($h.upstream.ready)）" -ForegroundColor Green
} catch {
    Write-Host "插件没应答：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  → dsh web 起着吗？插件装了吗？" -ForegroundColor DarkGray
}

Write-Host "`n完成。手机上点一次「启动隧道」就会自动找到这台电脑。" -ForegroundColor Green