# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号暂时跟 SemVer。

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