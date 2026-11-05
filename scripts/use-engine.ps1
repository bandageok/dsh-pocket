# 切换内置引擎的 CPU 架构
#
# 为什么要这个：APK 里的 libgojni.so 是按 CPU 架构编的。真机（arm64）和
# Android 模拟器（x86_64）要的是**不同的 .so**，装错了点「启动隧道」就崩。
# 这个脚本只是把预编好的 AAR 换进 android/app/libs/，再让你重新 compile。
#
# 用法：
#   pwsh scripts/use-engine.ps1 -Abi arm64     # 真机
#   pwsh scripts/use-engine.ps1 -Abi amd64     # 模拟器
#
# 预编好的放在 android/engines/（不入库，免得仓库里躺 35 MB 二进制）。
# 缺了会调用 gomobile 现场编（需要 Go + NDK，见 scripts/build-libtailscale.ps1）。
param(
    [ValidateSet("arm64", "amd64")] [string]$Abi = "arm64",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $here "android\engines"
$target = Join-Path $here "android\app\libs\libtailscale.aar"
$cache = Join-Path $engineDir "libtailscale-$Abi.aar"

New-Item -ItemType Directory -Force -Path $engineDir, (Split-Path $target) | Out-Null

if (-not (Test-Path $cache) -or $Force) {
    Write-Host "没有 $Abi 的引擎，试着现场编译…" -ForegroundColor Yellow
    $go = Join-Path $env:ProgramFiles "Go\bin\go.exe"
    if (Test-Path "C:\Android\go\bin\go.exe") { $go = "C:\Android\go\bin\go.exe" }
    if (-not (Test-Path $go)) { throw "缺 Go，见 scripts/build-libtailscale.ps1 的头部说明" }
    $gomobile = Join-Path $env:USERPROFILE "go\bin\gomobile.exe"
    if (Test-Path "C:\Android\gopath\bin\gomobile.exe") { $gomobile = "C:\Android\gopath\bin\gomobile.exe" }
    if (-not (Test-Path $gomobile)) { throw "缺 gomobile（go install golang.org/x/mobile/cmd/gomobile@latest）" }

    $src = "C:\Android\ts-android"
    if (-not (Test-Path $src)) { git clone --depth 1 https://github.com/tailscale/tailscale-android $src }

    Push-Location $src
    try {
        & $gomobile bind -androidapi 24 -target="android/$Abi" -o $cache ./libtailscale
    } finally {
        Pop-Location
    }
}

Copy-Item $cache $target -Force
$mb = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "已切换为 $Abi 引擎（$mb MB）→ $target" -ForegroundColor Green
Write-Host "接着编译：cd android; .\gradlew.bat assembleDebug" -ForegroundColor Green