# 重装 Windows 端 Tailscale，修掉「两个 SYSTEM 级 tailscaled 抢管道 / no backend」
#
# 为什么需要它：这台机器上出现了**两个 session 0 的 tailscaled**，互相抢默认命名管道，
# 于是 CLI 时而 503 no backend、时而挂死；托盘 Log in 也没反应。
# 非管理员杀不掉这两个进程，卸载也静默失败 —— 所以必须提权跑。
#
# 用法（管理员 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reinstall-tailscale.ps1 -NoElevate
# 或者直接双击：scripts\reinstall-tailscale.cmd
#
# 做的事：
#   1. 停服务、杀所有 tailscaled
#   2. 用本地缓存的 MSI 卸载（不动 C:\ProgramData\Tailscale 登录态）
#   3. 重装
#   4. 起服务，等后端真正就绪（等的是守护进程的管道 + `status` 有输出）
#   5. 若仍失败，打印服务日志尾部，并给出下一步（重启 / userspace 兜底）
param([switch]$NoElevate, [switch]$KeepState)

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

if (-not (Test-Admin)) {
    Write-Host "这个脚本必须以管理员运行。" -ForegroundColor Red
    exit 1
}

function Read-DaemonPipe {
    Test-Path $daemonPipe
}

Write-Host "`n[1/6] 停服务并清掉所有 tailscaled" -ForegroundColor Cyan
Stop-Service Tailscale -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Process tailscaled, tailscale-ipn -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Kill(); Write-Host "  killed $($_.ProcessName) $($_.Id)" } catch { }
}
Start-Sleep -Seconds 3

Write-Host "`n[2/6] 找本地缓存的安装包" -ForegroundColor Cyan
$msi = Get-ChildItem "C:\ProgramData\Package Cache" -Recurse -Filter "tailscale-setup-*-amd64.msi" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$exe = Get-ChildItem "C:\ProgramData\Package Cache" -Recurse -Filter "tailscale-setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msi -and -not $exe) {
    Write-Host "缓存里没有安装包。请到 https://tailscale.com/download/windows 下载后重装。" -ForegroundColor Red
    exit 2
}
Write-Host "  $($msi.FullName)" -ForegroundColor DarkGray

Write-Host "`n[3/6] 卸载（保留 C:\ProgramData\Tailscale 里的登录态）" -ForegroundColor Cyan
if ($msi) {
    Start-Process msiexec.exe -ArgumentList @("/x", "`"$($msi.FullName)`"", "/qn", "/norestart") -Wait
} else {
    Start-Process $exe.FullName -ArgumentList @("/uninstall", "/quiet", "/norestart") -Wait
}
Start-Sleep -Seconds 5

Write-Host "`n[4/6] 重装" -ForegroundColor Cyan
if ($msi) {
    Start-Process msiexec.exe -ArgumentList @("/i", "`"$($msi.FullName)`"", "/qn", "/norestart") -Wait
} else {
    Start-Process $exe.FullName -ArgumentList @("/quiet", "/norestart") -Wait
}
Start-Sleep -Seconds 8

Write-Host "`n[5/6] 起服务并等后端就绪" -ForegroundColor Cyan
Start-Service Tailscale -ErrorAction SilentlyContinue
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Read-DaemonPipe) {
        $job = Start-Job { & "C:\Program Files\Tailscale\tailscale.exe" status 2>&1 }
        if (Wait-Job $job -Timeout 6) {
            $out = (Receive-Job $job | Out-String)
            if ($out -and $out -notmatch 'no backend') { $ok = $true }
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        if ($ok) { break }
    }
}

Write-Host "`n[6/6] 结果" -ForegroundColor Cyan
if ($ok) {
    & $ts status
    Write-Host "`n后端正常。如果显示的不是 100.x，点托盘图标 → Log in（登录态若被清掉）。" -ForegroundColor Green
} else {
    Write-Host "后端仍未就绪。服务日志最后 15 行：" -ForegroundColor Red
    $log = Get-ChildItem $svcLogDir -Filter *.txt -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) { Get-Content $log.FullName -Tail 15 | ForEach-Object { Write-Host "  $_" } }
    Write-Host "`n下一步：重启一次电脑；仍不行就用 userspace 兜底（告诉我就行，我配计划任务）。" -ForegroundColor Yellow
}