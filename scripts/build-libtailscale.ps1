# 产出 libtailscale.aar（内置 Tailscale 的唯一前置件）
#
# 为什么需要它：Tailscale 的客户端引擎是 Go 写的，Android 这边要能用，必须用
# `gomobile bind` 把它编译成 AAR（含 libgojni.so + 配套的 Java 绑定类）。
# 参考实现 DSHgo 也是这么做的 —— 它发布出来的 APK 里只有 .so、没有 Java 绑定类
# （见 docs/REVERSE-ENGINEERING.md），所以「抄它的 APK」是抄不到这一层的。
#
# 前置：
#   · Go 1.22+（winget install GoLang.Go，或 https://dl.google.com/go/）
#   · Android NDK（sdkmanager "ndk;26.1.10909125"）
#   · 能访问 Go module proxy（goproxy.cn / goproxy.io / proxy.golang.org 任一个）
#     —— 这一步是硬门槛：没有 proxy，`go mod download` 拉不动 tailscale 的上百个依赖。
#
# 用法：
#   pwsh scripts/build-libtailscale.ps1 -Goproxy https://goproxy.cn
#   产物：android/app/libs/libtailscale.aar
#   然后：cd android && ./gradlew assembleDebug   # 会自动带上它
param(
    [string]$Goproxy = "https://goproxy.cn",
    [string]$NdkVersion = "26.1.10909125",
    [string]$Work = "$env:TEMP\libtailscale-build",
    [string]$Out = ""
)

$ErrorActionPreference = "Stop"

function Need($cmd) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "缺 $cmd。先装：winget install $cmd 或见脚本头部说明。"
    }
}

Need "go"
Need "git"

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
$ndk = Join-Path $sdk "ndk\$NdkVersion"
if (-not (Test-Path $ndk)) {
    throw "找不到 NDK：$ndk（用 sdkmanager 装：sdkmanager `"ndk;$NdkVersion`"）"
}

$gopath = Join-Path $Work "gopath"
New-Item -ItemType Directory -Force -Path $Work, $gopath | Out-Null

$env:GOFLAGS = "-mod=mod"
$env:GOPROXY = $Goproxy
$env:GOSUMDB = "off"
$env:GOPATH = $gopath
$env:ANDROID_HOME = $sdk
$env:ANDROID_NDK_HOME = $ndk

Write-Host "[1/5] 装 gomobile（拉 golang.org/x/mobile）" -ForegroundColor Cyan
go install golang.org/x/mobile/cmd/gomobile@latest
$gomobile = Join-Path $gopath "bin\gomobile.exe"
if (-not (Test-Path $gomobile)) { throw "gomobile 没装上，检查 GOPROXY 是否可用" }

Write-Host "[2/5] gomobile init（指向 NDK）" -ForegroundColor Cyan
& $gomobile init -ndk $ndk

Write-Host "[3/5] 取 tailscale-android 源码" -ForegroundColor Cyan
$src = Join-Path $Work "tailscale-android"
if (-not (Test-Path $src)) {
    git clone --depth 1 https://github.com/tailscale/tailscale-android $src
} else {
    git -C $src pull --ff-only
}

Write-Host "[4/5] 拉依赖（这一步最慢，且必须有 GOPROXY）" -ForegroundColor Cyan
Push-Location $src
try {
    go mod download
} finally {
    Pop-Location
}

Write-Host "[5/5] gomobile bind → libtailscale.aar" -ForegroundColor Cyan
if (-not $Out) {
    $Out = Join-Path $PSScriptRoot "..\android\app\libs\libtailscale.aar"
}
$Out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

Push-Location $src
try {
    & $gomobile bind -target=android/arm64,android/arm -o $Out ./libtailscale
} finally {
    Pop-Location
}

if (Test-Path $Out) {
    $size = [math]::Round((Get-Item $Out).Length / 1MB, 1)
    Write-Host "完成：$Out（$size MB）" -ForegroundColor Green
    Write-Host "下一步：cd android; .\gradlew.bat assembleDebug" -ForegroundColor Green
} else {
    throw "没产出 AAR —— 看上面 gomobile 的输出"
}