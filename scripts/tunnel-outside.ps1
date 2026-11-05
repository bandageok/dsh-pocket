# 在外面操控电脑上的 dsh：用 Cloudflare 快速隧道把插件发布到公网
#
# 为什么用它（而不是 Tailscale）：
#   · 不需要账号、不需要域名、不需要管理员权限、不装虚拟网卡；
#   · 这台机器上 Tailscale 的服务后端起不来（COM/DNS 组件损坏，重装无效），这条路绕开它；
#   · 实测：https://<随机>.trycloudflare.com/__pocket__/health → 200，
#     配对、拉会话、SSE 全通。
#
# 代价（必须知道）：
#   · 地址每次重启都会变（本脚本会把当前地址写进 public-url.txt）；
#   · 流量经 Cloudflare 明文转发 —— 我们的插件有配对码/设备令牌闸门，但别把这当成端到端加密；
#   · 快速隧道是"试用"性质，Cloudflare 不保证可用性。长期用就换成带域名和 Cloudflare Access 的命名隧道。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel-outside.ps1
#   ... -Status     只看当前地址与连通性
#   ... -Install    注册登录自启的计划任务（保持隧道常开）
#   ... -Port 3081  指定本地端口
param(
    [switch]$Status,
    [switch]$Install,
    [int]$Port = 3081,
    [string]$Exe = "C:\Android\downloads\cloudflared-windows-amd64.exe"
)

$ErrorActionPreference = "Continue"
$stateDir = "$env:LOCALAPPDATA\DshPocket"
$urlFile = Join-Path $stateDir "public-url.txt"
$logFile = Join-Path $stateDir "cloudflared.log"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Read-Url {
    if (-not (Test-Path $urlFile)) { return $null }
    $u = (Get-Content $urlFile -Raw).Trim()
    if ($u -match '^https://') { return $u } else { return $null }
}

function Test-Local {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$Port/__pocket__/health" -TimeoutSec 4
        return $h
    } catch { return $null }
}

if ($Status) {
    $local = Test-Local
    if (-not $local) { Write-Host "本地插件没应答（dsh web / 插件没跑？）" -ForegroundColor Red }
    else { Write-Host "本地插件：正常（上游 $($local.upstream.port)，ready=$($local.upstream.ready)）" -ForegroundColor Green }
    $u = Read-Url
    if (-not $u) { Write-Host "还没有公网地址：先跑一次本脚本（不带 -Status）" -ForegroundColor Yellow; exit 2 }
    Write-Host "公网地址：$u" -ForegroundColor Green
    try {
        $body = & curl.exe -s --ssl-no-revoke --max-time 15 "$u/__pocket__/health"
    $h = $body | ConvertFrom-Json
        Write-Host "公网连通：正常（version $($h.version)）" -ForegroundColor Green
        Write-Host "手机打开：$u/__pocket__/" -ForegroundColor Green
    } catch {
        Write-Host "公网地址不通：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "（隧道进程可能已退出，重跑本脚本会拿到新地址）" -ForegroundColor DarkGray
    }
    exit 0
}

if (-not (Test-Path $Exe)) {
    Write-Host "找不到 cloudflared：$Exe" -ForegroundColor Red
    Write-Host "下载：gh release download -R cloudflare/cloudflared -p cloudflared-windows-amd64.exe -D C:\Android\downloads" -ForegroundColor DarkGray
    exit 1
}

$local = Test-Local
if (-not $local) {
    Write-Host "本地 $Port 没应答 —— 先把 dsh web 和插件跑起来。" -ForegroundColor Red
    exit 2
}

$running = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $running) {
    Write-Host "启动隧道…" -ForegroundColor Cyan
    Start-Process -FilePath $Exe -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate", "--logfile", $logFile) -WindowStyle Hidden
} else {
    Write-Host "隧道进程已在跑，复用。" -ForegroundColor DarkGray
}

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    foreach ($f in @($logFile, "$logFile.out")) {
        if (Test-Path $f) {
            $hit = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $url = $hit.Matches[0].Value; break }
        }
    }
    if ($url) { break }
}

if (-not $url) {
    Write-Host "没拿到公网地址。看日志：$logFile" -ForegroundColor Red
    Get-Content $logFile -Tail 10 -ErrorAction SilentlyContinue
    exit 3
}

Set-Content -Path $urlFile -Value $url -Encoding ASCII
Write-Host "`n公网地址：$url" -ForegroundColor Green

Write-Host "验证连通性…" -ForegroundColor Cyan
try {
    $body = & curl.exe -s --ssl-no-revoke --max-time 20 "$url/__pocket__/health"
    $h = $body | ConvertFrom-Json
    Write-Host "验证通过（version $($h.version)，paired=$($h.paired)）" -ForegroundColor Green
} catch {
    Write-Host "首次验证失败：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "（Cloudflare 边缘生效可能要十几秒，稍后重试：加 -Status）" -ForegroundColor DarkGray
}

$code = $null
$pf = "$env:USERPROFILE\.dsh\pocket.json"
if (Test-Path $pf) { $code = (Get-Content $pf -Raw | ConvertFrom-Json).code }

Write-Host "`n手机在「外面」时：" -ForegroundColor Cyan
Write-Host "  地址：$url/__pocket__/"
if ($code) { Write-Host "  配对码：$code" -ForegroundColor Green }
Write-Host "  或者直接把上面地址填进 App 的地址栏（它会自动补 /__pocket__/）"

if ($Install) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
        "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"")
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "DshPocket-Tunnel" -Action $action -Trigger $trigger -Force | Out-Null
    Write-Host "`n已注册计划任务 DshPocket-Tunnel（登录时自动开隧道，地址写进 $urlFile）" -ForegroundColor Green
}