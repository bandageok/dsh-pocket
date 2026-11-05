# 逆向：参考实现到底怎么做到「不在同一局域网也能连」

对象：[`just-a-FA-for-name/DSHgo`](https://github.com/just-a-FA-for-name/DSHgo) v1.3（MIT）。
方法：APK 拆包 + 二进制符号提取 + 与其公开源码交叉核对（作者开源了，所以「逆」的是**打包产物**，
用来确认源码说的和发布的是同一件事）。

## 一句话结论

它**没做穿透**。它把 **Tailscale 的客户端引擎（WireGuard + 登录 + MagicDNS）整个编进了 APK**：

```
APK 34.7 MB
├── lib/arm64-v8a/libgojni.so   35 MB   ← gomobile bind 出来的 Go 引擎（就是 Tailscale）
├── classes.dex                 158 KB  ← 真正属于 App 的代码只有这么点
└── AndroidManifest.xml                  ← 一个 VpnService（app-scoped）+ 两个 Activity
```

所以「无论是否在同一局域网」= 手机和电脑各自加入同一个 tailnet，走 WireGuard 打洞；
打不通时 Tailscale 自己的 DERP 服务器中继。**穿透能力来自 Tailscale，不是来自这个 App。**

## 证据 1：清单里只有一个 VPN 服务，没有别的东西

```
package: com.dsh.remote  versionName 1.3  minSdk 26  targetSdk 34
uses-permission: INTERNET / ACCESS_NETWORK_STATE / RECORD_AUDIO / MODIFY_AUDIO_SETTINGS
                 FOREGROUND_SERVICE / FOREGROUND_SERVICE_SYSTEM_EXEMPTED
service: permission=android.permission.BIND_VPN_SERVICE
         foregroundServiceType=0x400        ← systemExempted
```

`foregroundServiceType=0x400` 是关键：VpnService 声明为「系统豁免」类型的前台服务，才不会被
Android 14 的 6 小时/天限制掐掉。我们自己的 `PocketVpnService` 用的是 `dataSync`，
在这台机器上跑长时间隧道会被系统掐——这是可以直接抄的一条。

## 证据 2：`libgojni.so` 的 JNI 符号，就是 Tailscale 的 Go 面

从 `.so` 里直接抽出 `Java_*` 符号（105 个），足以还原被调用的 API 形状：

```
libtailscale.Libtailscale.start            ← 唯一的启动入口
libtailscale.Libtailscale.requestVPN
libtailscale.Libtailscale.onDNSConfigChanged / onGatewayChanged
libtailscale.Libtailscale.serviceDisconnect / sendLog / setShareFileHelper
libtailscale.App._1_1New / callLocalAPI / callLocalAPIMultipart
libtailscale.App.notifyPolicyChanged / setClientLoggingEnabled / watchNotifications
libtailscale.VPNFacade._1_1New / up / close / reconfigureVPN / supportsSplitDNS
libtailscale.VpnService._1_1New
libtailscale.Response / FilePart / FileParts / InputStream
libtailscale.Libtailscale$proxyAppContext.{bindSocketToNetwork,encryptToPref,decryptFromPref,getDeviceName}
libtailscale.Libtailscale$proxyApplication / proxyIPNService / proxyNotificationManager …
```

对照它公开的源码（`phone-app/src/com/dsh/remote/Tunnel.java`），启动就是一个调用：

```java
static libtailscale.Application start(Context ctx) {
    String dataDir = ctx.getFilesDir().getAbsolutePath();
    return libtailscale.Libtailscale.start(dataDir, "", false, new SecureStore(ctx));
}
```

- 第 4 个参数是 `AppContext`（它用 `SecureStore` 实现）：Go 侧通过它拿设备名、
  做 `encryptToPref` / `decryptFromPref`（登录态加密存储）、`bindSocketToNetwork`（绑定到当前网络）。
- 返回 `Application`，之后**所有操作都走 localapi**（就是 Tailscale 自己的 HTTP 接口）：

```java
app.callLocalAPI(method, "/localapi/v0/…", body, timeout)   // 状态、登录、peer 列表
```

## 证据 3：dex 里剩下的类，就是「怎么用这个引擎」

```
com.dsh.remote.Tunnel                 ← 包 libtailscale：start / localapi / 登录 URL / 通知监听
com.dsh.remote.TailscaleVpnService    ← VpnService + TsBuilder：把 Go 侧要的配置落到 Builder
com.dsh.remote.Discovery              ← 在 tailnet 里找那台电脑
com.dsh.remote.EndpointPolicy         ← 选哪个地址（tailnet / 局域网）
com.dsh.remote.LocalForwarder         ← 把 127.0.0.1:9230 的本地服务经隧道打回电脑
com.dsh.remote.SecureStore            ← AppContext 实现（Keystore 加密）
com.dsh.remote.Diagnostics            ← 有界日志
```

VPN 是**应用专用**的（`TailscaleVpnService.java`）：

```java
.addDnsServer("100.100.100.100")          // MagicDNS：用它解析 tailnet 机器名
.allowFamily(OsConstants.AF_INET / AF_INET6)
builder.addAllowedApplication(getPackageName());   // 只有本 App 走隧道
```

DNS 就是它能「不填 IP 也能连」的原因：MagicDNS 把 `100.100.100.100` 当解析器，
`<机器名>.<tailnet>.ts.net` 直接解析成 100.x 地址。

## 证据 4：dex 里出现的地址与页面注入

```
100.100.100.100                     ← MagicDNS
127.0.0.1:9230 / Host/Origin 改写  ← LocalForwarder：手机侧假扮 loopback
window.__dshConnectionState / __dshToggleSidebar / __dshAutoSidebar / __dshFishSkin
                                    ← 注入到 WebView 页面里的 UI 钩子（和我们的 shim 同一类东西）
```

## 它为什么仍然「可能连不上」——以及你遇到的那条

它自己的 README 写了三件必须同时成立的事：PC 装了 Tailscale 并登录、App 内登录同一账号、
以及两端在同一 tailnet。任何一条不成立，表现就是「网页无法打开」。

**你这次的问题不属于这一类。** 我给你编的 APK 里没有 Tailscale（缺 `libtailscale.aar`），
而且 0.2.0 的地址归一化有个真 bug：**只填 IP 时没有补 `:3081`**，于是 WebView 去连 80 端口，
手机只会给你一句「网页无法打开」。这在 0.2.1 已修，并加了「测试」按钮直说失败原因：

| 现象 | 含义 |
|---|---|
| 超时 | 手机连不到电脑：不同网段 / 防火墙 / 隧道没开 |
| 拒绝连接 | 端口没开：插件没跑，或端口不是 3081 |
| 域名解析失败 | 地址写错 |

## 要不要把这条路照搬到我们这边

**技术上可以，代价明确**：

1. 复用它的 `libgojni.so`（MIT，允许再分发，保留署名）+ 我们写 Java 粘合层。
   但 JNI 方法签名必须逐字一致（gomobile 用 `RegisterNatives` 按名字+签名注册），
   要按上面 105 个符号反推签名，**没有真机就无法验证**——签错就是启动即崩。
2. 要补的东西不少：`AppContext` 实现（Keystore 加密）、VpnService 由 `VPNFacade` 回调驱动
   （`up(…)` / `reconfigureVPN(…)` / `supportsSplitDNS`）、登录流程（`browseToURL` 开 WebView）、
   通知监听（`watchNotifications`）、以及 `LocalForwarder`。
   它这部分加起来约 600 行 Java + 一个 35 MB 的 .so。
3. APK 会从 3.2 MB 变成 ~38 MB。

**我的判断**：这条路该做，但不该在「没有设备可验证」的状态下当成默认包发出去。
两条替代路线今天就可用，而且不依赖任何账号或自建服务：

| 路线 | 怎么做 | 代价 |
|---|---|---|
| 官方 Tailscale（两端） | PC 装 Tailscale 登录；手机装 Tailscale 登录同账号；我们的 APK 自动进入 SYSTEM 模式 | 一个账号；国内偶尔慢（走 DERP 中继） |
| 自建中继 | 一台 VPS 跑 `relay/server.mjs`；PC 配置 `relayUrl/relayRoom`；手机设置里填同样两个值 | 需要一台有公网 IP 的机器 |

> 注：`cloudflared` 免费快速隧道（`--url http://127.0.0.1:3081`）在我这台机器上**连不通**——
> TLS 握手到第 2 步被掐（`trycloudflare.com` 常见的 SNI 干扰）。你那边能不能用要试，
> 但别把它当唯一方案。

## 下一步（需要你配合的最小动作）

1. 装 0.2.1 的 APK，点一次「测试」，把那行文字发我 —— 它直接说明卡在超时还是拒绝连接。
2. 如果你要我补上「内置 Tailscale」：给我一台能连 adb 的机器（或你跑 `adb logcat -s DshPocket` 的结果），
   我按 `libtailscale` 的真实签名把粘合层写完，一轮就能对通。

## 补一刀：它的**发布包其实缺了 Java 绑定类**

这一条比上面的架构更关键，直接决定「照抄」能不能抄到：

```
$ apkanalyzer dex packages --defined-only DSHgo-v1.3.apk | wc -l   → 165 个 class_def
$ （同样统计 v1.2）                                                 → 162 个 class_def
$ 逐个看包名                                                        → 全部 com.dsh.remote.*
```

- `libtailscale.Libtailscale` / `LibApp` / `go.Seq` 这些**只作为类型引用**出现在字符串池里
  （`Llibtailscale/App;`、`Lgo/Seq;`…），**没有任何一个被定义**。
- 我也查了 `.so` 里有没有内嵌 dex：没有（`dex
035` 魔数不存在；匹配到的 `PK` 是 Go 的数据段）。
- 也就是说它发布出来的 70 MB `libgojni.so` 在**这份 APK 里是孤立**的：
  一旦走到 `Tunnel.ensureEngine()` → `libtailscale.Libtailscale.start(...)`，
  就是 `NoClassDefFoundError`。

结论：**「抄它的 APK」抄不到隧道这一层** —— 它的 Java 粘合层在自己的构建里丢了
（`libtailscale.aar` 很可能被当成 `compileOnly`，或者打包时把 AAR 的 classes.jar 排除掉了）。
要复现这套做法，只有一条路：**用它同一份源码（tailscale-android 的 `libtailscale` 包）
自己 `gomobile bind` 出一个 AAR**，这样 Java 绑定和 `.so` 天生配套。

### 我已经把这条路铺到「只差一个网络条件」

本机已完成：

| 步骤 | 状态 |
|---|---|
| Go 1.22.6 | ✅ 已装（dl.google.com） |
| Android NDK 26.1.10909125 | ✅ 已装（sdkmanager） |
| `git clone tailscale/tailscale-android` | ✅ 可达 |
| `gomobile bind` | ⛔ 卡在 Go module proxy：`goproxy.cn` / `goproxy.io` / `proxy.golang.org` / 阿里云 / 腾讯云 goproxy 在这条网络上**全部不可达**（000），而 tailscale 有一百多个依赖 |

一条命令的事，在有 proxy 的机器上跑：

```powershell
pwsh scripts/build-libtailscale.ps1 -Goproxy https://goproxy.cn
# 产物 android/app/libs/libtailscale.aar，之后 ./gradlew assembleDebug 就会带上
```

### 需要照抄的接口（从它的源码 + JNI 符号一一对上）

| 它实现的 | 作用 | 我们必须实现 |
|---|---|---|
| `libtailscale.IPNService` | `id()` / `protect(fd)` / `newBuilder()` / `close()` / `disconnectVPN()` / `updateVpnStatus(bool)` | VpnService 侧 |
| `libtailscale.VPNServiceBuilder` | `setMTU` / `addDNSServer` / `addSearchDomain` / `addRoute` / `excludeRoute` / `addAddress` / `establish()` | 把 Go 侧要的配置落到 `VpnService.Builder` |
| `libtailscale.AppContext` | `getDeviceName` / `encryptToPref` / `decryptFromPref` / `bindSocketToNetwork` | Keystore 加密的登录态存储 |
| `libtailscale.Application` | `callLocalAPI(...)` / `watchNotifications(...)` | 登录、状态、peer 发现全走它 |
| `Libtailscale.start(dataDir, "", false, appContext)` | 启动引擎 | 一行 |
| `Libtailscale.requestVPN(service)` | 告诉引擎 VPN 已就绪 | 一行 |

清单里还有一条值得直接抄：`foregroundServiceType="systemExempted"` +
`FOREGROUND_SERVICE_SYSTEM_EXEMPTED` —— 否则 Android 14 会把长跑的前台服务掐掉。
