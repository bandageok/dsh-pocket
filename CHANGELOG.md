# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号暂时跟 SemVer。

## [0.3.0] — 2026-11-05

### 新增：内置 Tailscale（跨网络不再依赖系统 App 或中继）

- 用 `gomobile bind` 自建 `libtailscale.aar`（16.7 MB，arm64+arm），入库并随 APK 打包；
  APK 28.7 MB，dex 里**定义了** `libtailscale.*`（277 个条目），`lib/arm64-v8a/libgojni.so` 25.4 MB。
- 实现 gomobile 生成的三个接口，结构照搬参考实现 DSHgo：
  - `AppContext`（22 个方法）：设备名、Keystore AES-GCM 加密的登录态、`bindSocketToNetwork`、日志与 SDK 信息
  - `IPNService` + `VPNServiceBuilder`：`addAllowedApplication(packageName)` 做**应用专用隧道**，
    MagicDNS `100.100.100.100`，配置由 Go 侧回调驱动
  - localapi 驱动：`start` / `prefs(WantRunning)` / `status` / `login-interactive` / `watchNotifications`
- App 内一键流程：启动隧道 → VPN 授权 → 未登录时把 Tailscale 授权页放进 WebView →
  Running 后扫描在线 peer 的 3081 端口找到电脑 → 直接打开 DSH。
- 清单加 `FOREGROUND_SERVICE_SYSTEM_EXEMPTED` + `foregroundServiceType="systemExempted"`，
  否则 Android 14 会掐掉长跑的前台 VPN 服务。

### 修复

- 参考实现的发布包只有 `.so`、没有 gomobile 的 Java 绑定类（好东西抄不到），
  这次自建 AAR 把这一层补齐了；证据见 `docs/REVERSE-ENGINEERING.md`。

## [0.2.1] — 2026-11-05

### 修复

- **只填 IP 时没有补 `:3081`**：地址归一化把 `10.0.0.5` 变成 `http://10.0.0.5/__pocket__/`，
  于是去连 80 端口，手机上只显示「网页无法打开」。现在裸 IP / localhost 自动补 3081，
  `https://` 域名则保持默认 443 不补。
- 加了**「测试」按钮**：不做连接，直接回答卡在哪 —— 超时（不同网段/防火墙/隧道没开）、
  拒绝连接（端口没开）、域名解析失败，并显示耗时与当前隧道模式。
- WebView 主文档加载失败时不再白屏，改为显示具体地址与原因。

### 文档

- 新增 `docs/REVERSE-ENGINEERING.md`：拆参考实现 DSHgo v1.3 的 APK，从 `libgojni.so` 提取 105 个
  JNI 符号、还原它的启动调用与 localapi 流程，说明它「不在同一局域网也能连」的真实原因是
  **把 Tailscale 客户端引擎编进了 APK**，并给出照搬的代价与两条今天可用的替代路线。

## [0.2.0] — 2026-11-05

### 新增

- **双端同步**（`plugin/lib/follow.mjs`）：订阅上游 `session/follow`，把快照与增量事件归一成消息；
  断线指数退避重连并重挂会话；5 分钟没人看自动退订。
  - 只同步「对话内容」：`system/message`（系统提示词）、`runtime-context`、`<system-reminder>` 注入提醒全部丢弃。
  - 上行用 `requestId` ↔ 上游 `source.rpcId` 对账，手机本地回声被正式消息替换，不出现两条。
- **零依赖 WebSocket 客户端**（`lib/ws-client.mjs`）：上游 `/api/remote.mux` 要 cookie，标准 API 传不了头。
- **回环穿透**（`lib/loop.mjs`）：`/__pocket__/loop/<port>/…` 转发到电脑的 `127.0.0.1:<port>`，
  页面侧 shim 改写 `fetch`/XHR/WebSocket。默认关闭，只认白名单。
- **断点续传**（`lib/upload.mjs`）：`init` 幂等、offset 严格对齐、`finish` 不重放；单文件 512 MiB / 总量 2 GiB / 30 分钟回收。
- **有界诊断环**（`lib/diag.mjs`）：512 条，只有事件码与数字；`/api/diag` 与 `?download=1` 导出。
- **上游自愈**：连续失败 3 次自动重铸会话 cookie；`health` 如实报 `upstream.failures`。
- **手机端**：会话转录（含逐字 `delta`）、本地回声与去重、IndexedDB 离线缓存、文件上传（自适应分块）、
  自动探测地址、诊断导出、配对码链接（`#code=`）。
- **原生壳**（`android/`）：Kotlin + WebView，复用同一套 PWA 页面；三档隧道（内置 / 系统 Tailscale / 局域网）；
  `WatchService` 常驻事件流，把「待审批」「跑完了」推成系统通知；`addAllowedApplication` 做应用专用隧道。
- **可选中继**（`relay/server.mjs`）：自己实现 RFC6455 最小子集，零依赖；电脑拨出、手机会合。
- CI：后端测试 + 手机端自检 + Android `assembleDebug` 三件套。

### 修复

- `health.transport.relay` 之前读的是一份从未被写入的持久配置，配了中继也显示 `null`；
  现在以**运行中的拨号**为准，并区分「配了但没连上」（`connected: false`）。
- 中继装配从两个入口（插件、standalone）收进 `createStack`，避免两条路径漂移。
- 手机端 `write()` 的状态表把函数值当字符串拼接，502 时会 toast 出 `[object Function]`。

### 验证

- 自动化：插件 52 条 + 中继 4 条 + 手机端 72 项自检，全绿。
- 真机/真进程：`tools/probe-follow.mjs`（对真 dsh 验同步帧）与 `tools/tunnel-sim.mjs`
  （真中继 + 真拨号 + 手机侧帧，覆盖配对/快照/指令/内容/rpcId 对账/诊断）跑通。

## [0.1.0] — 2026-11-04

### 新增

- dsh 插件：LAN 反代（Host/Origin 改写、首屏注入 launch token、页面 polyfill、WebSocket 穿透）。
- 访问闸门：6 位配对码 + 设备令牌（HMAC），失败 5 次锁 5 分钟，配对成功即轮换配对码。
- 手机端 PWA：会话列表 / 详情 / 设置 / 连接四屏。
- 手机 API：`/api/state`、`prompt`、`cancel`、`approval`、SSE 流。
- 审批：`observe`（只展示）与 `answer`（手机可批准，超时交回桌面）两档。
- 中继拨号客户端 + 可自建中继服务。
- 文档：PROTOCOL / ARCHITECTURE / SECURITY / TROUBLESHOOTING。