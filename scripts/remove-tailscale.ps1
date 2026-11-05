# 彻底卸载 Windows 上的 Tailscale（自提权）
#
# 为什么需要专门一个脚本：
#   · 这台机器上 Tailscale 的文件被改坏过（两个 SYSTEM 级 tailscaled 抢管道、服务后端起不来），
#     `Stop-Service` 会报「无法打开计算机上的 Tailscale 服务」——那是权限/服务状态损坏，
#     不是服务真的不能停；
#   · 普通窗口（非管理员）连服务句柄都拿不到，所以必须先提权；
#   · 坏的安装用 msiexec /x 常常静默失败，所以这里做三层兜底：msiexec 卸载 → sc delete 删服务
#     注册 → 清残留目录。
#
# 本项目已不再依赖 Tailscale（0.4.0 起移除内置引擎，跨网络走 scripts/outside-tunnel.ps1），
# 所以这只是清理，不影响任何功能。
#
# 用法（双击 scripts\remove-tailscale.cmd，或在管理员窗口里）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\remove-tailscale.ps1 -NoElevate
param([switch]$NoElevate)

$ErrorActionPreference = "Continue"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin) -and -not $NoElevate) {
    Write-Host "需要管理员权限，正在提权（UAC 里点“是”）…" -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-NoElevate"
    ) | Out-Null
    exit
}

if (-not (Test-Admin)) {
    Write-Host "必须以管理员运行。" -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/5] 现状" -ForegroundColor Cyan
$svc = Get-Service Tailscale -ErrorAction SilentlyContinue
if ($svc) { Write-Host "  服务：$($svc.Status)" } else { Write-Host "  服务：不存在" }
Write-Host "  进程：$((Get-Process tailscaled, tailscale-ipn -ErrorAction SilentlyContinue | Measure-Object).Count) 个"

Write-Host "`n[2/5] 停服务并杀进程" -ForegroundColor Cyan
if ($svc) {
    sc.exe stop Tailscale | Out-Null
    Start-Sleep -Seconds 3
}
Get-Process tailscaled, tailscale-ipn -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Kill(); Write-Host "  killed $($_.ProcessName) $($_.Id)" } catch { }
}
Start-Sleep -Seconds 2

Write-Host "`n[3/5] 走正规卸载（msiexec，可能静默失败）" -ForegroundColor Cyan
$msi = Get-ChildItem "C:\ProgramData\Package Cache" -Recurse -Filter "tailscale-setup-*.msi" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$setupExe = Get-ChildItem "C:\ProgramData\Package Cache" -Recurse -Filter "tailscale-setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($msi) {
    Write-Host "  msiexec /x $($msi.Name)"
    Start-Process msiexec.exe -ArgumentList @("/x", "`"$($msi.FullName)`"", "/qn", "/norestart") -Wait
} elseif ($setupExe) {
    Write-Host "  $($setupExe.Name) /uninstall"
    Start-Process $setupExe.FullName -ArgumentList @("/uninstall", "/quiet", "/norestart") -Wait
} else {
    Write-Host "  缓存里没有安装包，跳过（下一步会直接删服务）" -ForegroundColor DarkGray
}
Start-Sleep -Seconds 5

Write-Host "`n[4/5] 兜底：直接删服务注册与残留文件" -ForegroundColor Cyan
if (Get-Service Tailscale -ErrorAction SilentlyContinue) {
    sc.exe delete Tailscale | Out-Null
    Start-Sleep -Seconds 2
}
foreach ($dir in @(
        "C:\Program Files\Tailscale",
        "C:\ProgramData\Tailscale",
        "$env:LOCALAPPDATA\Tailscale",
        "$env:LOCALAPPDATA\DshPocket\tsnet")) {
    if (Test-Path $dir) {
        try {
            Remove-Item $dir -Recurse -Force -ErrorAction Stop
            Write-Host "  已删除 $dir"
        } catch {
            Write-Host "  删不掉 $dir（$($_.Exception.Message)）" -ForegroundColor Yellow
        }
    }
}

Write-Host "`n[5/5] 验证" -ForegroundColor Cyan
$stillSvc = Get-Service Tailscale -ErrorAction SilentlyContinue
$stillProc = (Get-Process tailscaled, tailscale-ipn -ErrorAction SilentlyContinue | Measure-Object).Count
$stillDir = Test-Path "C:\Program Files\Tailscale"
Write-Host "  服务：$(if ($stillSvc) { $stillSvc.Status } else { '已移除' })"
Write-Host "  进程：$stillProc 个"
Write-Host "  程序目录：$(if ($stillDir) { '仍存在' } else { '已删除' })"

if (-not $stillSvc -and $stillProc -eq 0 -and -not $stillDir) {
    Write-Host "`n卸载完成。本项目已不依赖它，无需重启。" -ForegroundColor Green
} else {
    Write-Host "`n还有残留（见上）。重启一次再跑本脚本通常就干净了。" -ForegroundColor Yellow
    Write-Host "也可以去「设置 → 应用 → 已安装的应用」里点 Tailscale 的卸载。" -ForegroundColor DarkGray
}