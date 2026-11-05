# 原生 App（Android）

**一句话**：UI 还是插件服务的那套 PWA，原生壳只负责三件 PWA 做不到的事 ——
**系统通知、常驻事件流**。

## 现在能编、能装

```sh
cd android
./gradlew assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
```

本机已实测通过（JDK 17 / Android SDK 34 / Gradle 8.7），产物 3.2 MB：

```
package: dev.dshpocket.app  versionName=0.1.0  minSdk=24  targetSdk=34
权限：INTERNET / ACCESS_NETWORK_STATE / POST_NOTIFICATIONS / FOREGROUND_SERVICE(_DATA_SYNC)
组件：1 Activity + WatchService + PocketVpnService
```

仓库里放了一份编好的 debug APK：`dist/dsh-pocket-0.1.0-debug.apk`（debug 签名，可直接侧载）。

## 现在这个壳做什么

一个 WebView + 一个常驻通知服务，**不含任何 VPN/隧道代码**（0.4.0 起移除）：

| 能力 | 说明 |
|---|---|
| 地址栏 + 连接 / 测试 / 自动探测 | 地址归一化（裸 IP 自动补 `:3081`，脏值也能救回） |
| WebView 加载 PWA | 与浏览器里那套完全同一份页面 |
| `WatchService` | 常驻事件流，把「待审批 / 跑完了」推成系统通知 |
| `CrashLog` | 异常留痕，下次打开直接在状态栏显示原因 |
| 状态栏版本号 | 报问题时先确认版本 |

跨网络不靠手机端：电脑上跑 `scripts/outside-tunnel.ps1` 拿到公网地址，手机填进去即可。

## 构建

```powershell
cd android
.\gradlew.bat --no-daemon assembleDebug   # 产物 3.3 MB
```

无原生库、无 AAR 依赖，`assembleDebug` 不再需要 NDK/Go。

