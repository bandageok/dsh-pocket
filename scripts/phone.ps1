# 一键把「手机」摆到屏幕上：切引擎 → 编译 → 起模拟器（有窗口）→ 装机 → 启动
#
# 为什么需要这个脚本：默认的 tasks.json 里模拟器是 -no-window（给自动化用的），
# 界面上什么都看不到。想看手机界面就得带窗口起，而且引擎必须是 amd64 那份。
#
# 用法：
#   pwsh scripts/phone.ps1              # 直接来（编译 + 起窗口 + 装机 + 启动）
#   pwsh scripts/phone.ps1 -SkipBuild   # 已经编过，只起窗口装机
#   pwsh scripts/phone.ps1 -ColdBoot    # 丢开快照冷启动（模拟器行为异常时用）
param(
    [switch]$SkipBuild,
    [switch]$ColdBoot,
    [string]$Avd = "dshpocket",
    [int]$Port = 5554
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "C:\Android\sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
$emulator = Join-Path $sdk "emulator\emulator.exe"
$serial = "emulator-$Port"

if (-not $SkipBuild) {
    Write-Host "[1/5] 切到 amd64 引擎（模拟器是 x86_64）" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "use-engine.ps1") -Abi amd64

    Write-Host "[2/5] 编译 APK" -ForegroundColor Cyan
    Push-Location (Join-Path $root "android")
    try {
        $env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "D:\Java" }
        & ".\gradlew.bat" --no-daemon --console=plain assembleDebug
        if ($LASTEXITCODE -ne 0) { throw "编译失败，看上面的 Gradle 输出" }
    } finally {
        Pop-Location
    }
}

# 模拟器已开着就别再起一个（同一个端口起不来，报错很难看）
$running = & $adb devices | Select-String -SimpleMatch $serial
if (-not $running) {
    Write-Host "[3/5] 启动模拟器（带窗口）—— 第一次要十几秒" -ForegroundColor Cyan
    $args = @("-avd", $Avd, "-port", "$Port", "-gpu", "auto", "-no-audio", "-no-boot-anim")
    if ($ColdBoot) { $args += @("-no-snapshot") }
    Start-Process -FilePath $emulator -ArgumentList $args | Out-Null
} else {
    Write-Host "[3/5] 模拟器已在运行" -ForegroundColor DarkGray
}

Write-Host "[4/5] 等系统启动完成…" -ForegroundColor Cyan
& $adb -s $serial wait-for-device | Out-Null
$deadline = (Get-Date).AddMinutes(4)
do {
    $booted = (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($booted -eq "1") { break }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)
if ($booted -ne "1") { throw "模拟器 4 分钟还没起来。试 -ColdBoot，或看 %TEMP%\AndroidEmulator" }

Write-Host "[5/5] 装机并启动" -ForegroundColor Cyan
$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
& $adb -s $serial install -r $apk | Select-Object -Last 1
& $adb -s $serial shell am start -n dev.dshpocket.app/.MainActivity | Out-Null

Write-Host ""
Write-Host "手机窗口已打开（$serial）。接下来：" -ForegroundColor Green
Write-Host "  · 地址栏填 10.0.2.2:3081   ← 模拟器里这就是你这台电脑" -ForegroundColor Green
Write-Host "  · 点「连接」→ 输入配对码（下面这条命令会打印）" -ForegroundColor Green
Write-Host '    node -e "console.log(JSON.parse(require(''fs'').readFileSync(process.env.USERPROFILE+''/.dsh/pocket.json'',''utf8'')).code)"' -ForegroundColor DarkGray
Write-Host "  · 想看引擎日志：adb -s $serial logcat -s DshPocket Tailscale/gojni" -ForegroundColor Green