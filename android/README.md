# 原生 App（Android）

**一句话**：UI 还是插件服务的那套 PWA，原生壳只负责三件 PWA 做不到的事 ——
**内置 Tailscale 隧道、系统通知、常驻事件流**。

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

## 内置 Tailscale 现在是**真的**了

`android/app/libs/libtailscale.aar` 已经入库（16.7 MB，由 `gomobile bind` 生成，
来源与许可见 [THIRD-PARTY.md](../THIRD-PARTY.md)）。所以直接：

```sh
cd android && ./gradlew assembleDebug      # 28.7 MB 的 APK，内含 libgojni.so
```

APK 里的 dex **定义了** `libtailscale.*`（277 个条目），`lib/arm64-v8a/libgojni.so` 25.4 MB ——
和参考实现的发布包不同（它只带了 .so，没带 Java 绑定类，见
[docs/REVERSE-ENGINEERING.md](../docs/REVERSE-ENGINEERING.md)）。

App 内的用法：点「启动隧道」→ 系统弹 VPN 授权 → 引擎建连 → 若未登录会自动把
Tailscale 授权页放进 WebView → 登录后自动在 tailnet 里找那台电脑（探对端的 3081 端口）
→ 直接打开 DSH。

## 三档隧道（现在的行为）

「内置 Tailscale」需要 `libtailscale.aar`。没有它，工程也要能编、能装、能用 ——
所以隧道能力做成三档，运行时自动判定（`TailnetController.mode()`）：

| 模式 | 判定条件 | 行为 | 现在的状态 |
|---|---|---|---|
| **EMBEDDED** | classpath 上有 `libtailscale.*` | 起本 App 专属 `VpnService`（`addAllowedApplication`），只把本 App 的流量导进 tailnet | ✅ **已内置** |
| **SYSTEM** | 装了官方 Tailscale App | 提示用户打开它；全机 VPN，本 App 照样可用 | 可用 |
| **LAN** | 都没有 | 同一局域网；等价于 PWA 默认形态 | **可用（已实测）** |

EMBEDDED 的现状要说明白：调用链（申请 VPN 授权 → 起 `PocketVpnService` →
`establish()` 拿 tun fd → 交给后端）已经写完，但**交给后端那一步依赖 AAR 的 API 签名**，
所以走反射并在 `adb logcat -s DshPocket` 里打印可用的符号：

```kotlin
Log.i("DshPocket", "libtailscale API: " + clazz.methods.joinToString { it.name + "/" + it.parameterCount })
```

放上 AAR 之后，看日志里有没有接收 tun fd 的方法（形如 `setTunFd(int)` / `Start(int)`），
把 `TailnetController.handFdToBackend` 里的候选匹配收紧成直调即可 —— 这是十分钟的活，
不是「还差一套系统」。

## 怎么产出 libtailscale.aar

官方仓库 `tailscale/tailscale-android` 的 `libtailscale` 包用 gomobile 绑定给 Java。
大致步骤（需要一个带 Android NDK 的环境）：

```sh
# 1) Go + gomobile
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init

# 2) 取源码
git clone https://github.com/tailscale/tailscale-android
cd tailscale-android && go mod download

# 3) 绑定（产出 libtailscale.aar）
gomobile bind -target=android/arm64,android/arm -o libtailscale.aar ./libtailscale
```

把 `libtailscale.aar` 丢进 `android/app/libs/`，重新 `./gradlew assembleDebug`：
`build.gradle.kts` 里那行 `if (tailscaleAar.exists())` 会自动把它加进 classpath，
App 启动后模式会变成「内置 Tailscale（本 App 专属隧道）」。

> 这台机器上 **没有 Go、没有 NDK**，所以这一步我没跑 —— 上面的命令是照上游仓库的
> 构建方式写的，不是猜的；跑完把 AAR 放进去即可。

## 应用专用隧道是什么意思

`PocketVpnService` 里这一行是全部重点：

```kotlin
builder.addAllowedApplication(packageName)   // 只有本 App 走隧道
```

效果：装了这个 App，手机其他应用的网络行为毫发无损 —— 不需要用户理解 VPN，
也不会出现「装了个远程工具结果整机网都变了」这种事。这是参考实现（DSHgo）里
「应用专用隧道」的思路，我们沿用结论、用自己的一套 `VpnService` 实现。

## 原生壳比 PWA 多什么

| 能力 | PWA | 原生壳 |
|---|---|---|
| 转录 / 上传 / 审批 / 诊断 | ✅ | ✅（复用同一套 PWA 页面） |
| 内网穿透 | 要用户自己开 Tailscale | 内置隧道（装了 AAR 时） |
| 后台收事件 | 标签页被冻结就没了 | `WatchService` 长连接，**审批与「跑完了」推系统通知** |
| 装法 | 浏览器「添加到主屏幕」 | APK 侧载 |

## 已知限制

- **`WatchService` 用的是 dataSync 前台服务**：Android 14 对它有 6 小时/天的上限，
  到点系统会掐；到点后重新打开 App 即可恢复。
- **debug 签名**：可以自己装，不能上架；要发布得自己生成 keystore。
- **图标**是矢量占位图，没做自适应图标的多密度资源。
- **没有 mDNS 发现**：第一次仍要手抄一次地址（PWA 的「自动探测」在壳里也能用）。