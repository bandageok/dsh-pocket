# 架构

一句话：**手机只跟插件说话，插件只跟 `dsh web` 说话，两边都不改 DSH。**

```
┌─────────────┐   ① HTTP+SSE（局域网/Tailscale）        ┌──────────────────────────────┐
│  手机 PWA    │ ───────────────────────────────────────▶ │ dsh-pocket 插件 :3081        │
│  (浏览器)    │ ◀─────────────────────────────────────── │  ├─ gate      鉴权闸门        │
└─────────────┘   ③ WS（中继，不在同网段时）              │  ├─ pocket    /__pocket__/*  │
      │                                                  │  ├─ proxy     Host/Origin 改写│
      └──▶ relay :8787 ──WS──▶ relay.mjs ──HTTP──▶ 自己 ─┘  └─ relay     拨出到中继      │
                                                          └──────────────┬───────────────┘
                                                                          │ ② 回环
                                                                          ▼
                                                                  dsh web :3080
```

## 为什么是这个形状

### 1. 手机不复刻官方前端

DSH 的客户端面是 typert RPC（`POST /api/<ns>/<method>` 一元调用 + `ws /api/remote.mux` 流式），
重画一遍聊天界面成本极高，而且要跟着上游语义漂移。所以：

- **状态与动作**走插件自己的窄 API（`/__pocket__/api/*`），手机上画得动、改得动；
- **历史与逐字输出**交给官方 UI，PWA 一键打开，走同一个反代，令牌自动换 cookie。

这条线让 PWA 只有 5 个文件、约 1900 行，且没有构建步骤。

### 2. 插件只依赖两条宿主服务和 `/api`

```js
export const inject = ['connection', 'webServer']
```

- `ctx.webServer.port` → 上游端口
- `ctx.connection.authenticatedUrl(base)` → 现取 launch token（每次 `dsh web` 启动都变）

插件**不 import 任何 `@deepseek-ai/*` 包**。理由：内部服务名是 typert 的名字，会随版本改；
而 `/api` 是对外承诺（官方前端与 ACP 都走它）。升级 dsh 时，插件的失败面只有「这两个服务没了」。

### 3. 三道栅栏必须逐条处理

`dsh web` 不是「只是绑了 loopback」那么简单，源码（`api-request-trust`）里三道：

| 栅栏 | 表现 | 处理 |
|---|---|---|
| 只绑 `127.0.0.1` | 手机连不上 | 插件绑 `0.0.0.0`，另开端口，不碰上游绑定 |
| `/api` 的 Host/Origin 栅栏 | 非 loopback 的 Host 直接 403/401；Origin 必须与 Host 同源 | 入站请求的 `Host`/`Origin` 每跳都改写成固定的 `127.0.0.1:<dshPort>` |
| cookie 绑 authority | cookie 名是 `dsh-auth-<authority hash>`，校验比对签发时的 authority | 改写必须**每次一致**，换写法就换身份 |

加两件「不做就半残」的事：首屏注入一次 launch token、页面脚本之前补
`crypto.randomUUID` 与 `AbortSignal.any`（非安全上下文里没有，而连接层靠它生成 RPC id）。

### 4. 顺序即安全

```
请求 → 闸门（Bearer / pocket-auth / ?pocket=） → 决定放不放 → 才注入 launch token → 上游
```

反过来（先注入再拦）等于没拦：token 一注入，请求就已经是登录态了。
`pocket.mjs` 的路由注释与 `PROTOCOL.md §5` 都钉了这条。

### 5. 状态用轮询，不用第二条 WebSocket

手机要的是「哪些会话在跑、谁在等审批」。插件每 3 秒对**回环**发一次
`session/list`（几 KB），有变化才推给手机的 SSE。多一条 WS 就多一套断线重连要调，
而这条链路上真正的实时性来自 `approval/request` —— 那是**进程内**事件，插件直接挂，不需要 WS。

代价：会话状态最多滞后 3 秒。监控用途够用；要逐字，走「打开完整界面」。

### 6. 审批为什么默认只展示

`approval/request` 是 waterfall：谁先返回决定，谁就赢。

- `observe`（默认）：插件立刻返回 `undefined`（= 我不接管），只把请求推给手机。桌面 UI 照常工作。
- `answer`（可选）：插件挂住请求，等手机在 `approvalTimeoutMs` 内给决定；超时就返回 `undefined`，交回桌面。

`answer` 的风险写在这里而不是藏起来：插件注册得比桌面 UI 早，所以桌面开着时也可能是手机先接住。
默认关闭是为了「装完不会改变你原有的工作习惯」。

### 7. 中继为什么是拨出

家里/公司的电脑没有公网 IP，也不该开端口。拨出只需要能上网：

```
register(room, secret) → roomToken
WS  /relay/host?room&token      ← 桌面保持长连接
WS  /relay/client?room           ← 手机连入（房间存在且有 host 才 101）
帧：{t:'req', id, path, method, headers, body} / {t:'res', id, status, headers, body}
```

中继按 `id` 配对请求与响应，不认识 `path`。桌面收到 `req` 后**打给自己**的代理端口
（`127.0.0.1:<port>`），所以鉴权、改写、PWA 静态服务全部复用同一条路径 —— 不在中继里复制业务逻辑。

### 8. 双端同步为什么是「镜像 + 输入口」，不是两份存储

手机端没有 dsh 引擎、没有模型凭据，也不可能跑会话 —— 所以「两边各自追加、定期合并」这个模型
在这里必然退化成一堆边界情况：会话日志是**多帧 zstd**、目录名由文件头 `cwd` 派生、
索引只增不减……已归档的 `dsh-android-Conversation-sync` 用 8.3k 行 JS 处理的就是这些。

我们的选择：**电脑是唯一真相源**。

- 下行靠上游 `session/follow`（WS 流，同一个 socket 多路复用，每个会话一条逻辑流）。
  插件把帧归一成消息：只留人能看到的内容，丢掉 `system/message`（几 KB 系统提示词）、
  `runtime-context`、`<system-reminder>` 这类注入提醒。
- 上行靠 `session/prompt` 的 `requestId`：上游把它写进日志时会带上同一个 `source.rpcId`，
  手机用这个键把「本地回声」替换成正式消息。**去重的锚点是服务端给的，不是客户端猜的。**
- 断线重连（指数退避，上限 30 s）后按会话重发 `open`，手机侧用 `reset` 整段替换；
  离线时手机读 IndexedDB 缓存。

代价写在这里：手机看到的是「镜像」，不是离线可写的副本 —— 没有离线队列，
因为离线期间会话在电脑上可能已经被别的输入改写了。

### 9. 参考实现里值得学的，和我们自己的

参考对象是 [just-a-FA-for-name/DSHgo](https://github.com/just-a-FA-for-name/DSHgo)（手机远程控制 dsh 的
Android 方案）。它的工程判断值得学，实现不必照抄 —— 前提不同（它是原生 App + 内置 Tailscale，我们是 PWA）。

**学它的判断（不抄代码）：**

| 它的做法 | 我们的落点 |
|---|---|
| 插件只监督外部进程、不碰 dsh 内部（升级打不挂） | 同一条规则：只依赖 `ctx.webServer.port` 与 `ctx.connection.authenticatedUrl` |
| Host/Origin 改写成固定 loopback authority | 同一条（这是 cookie 绑 authority 决定的，没有第二种解法） |
| 首屏注入 launch token、补 `crypto.randomUUID` / `AbortSignal.any` | 同一条（非安全上下文里没有，缺了就是「能打开但发不出消息」） |
| 上传：offset 严格对齐、创建幂等、磁盘上限、finish 不重放 | 全盘采纳，重写为 `upload.mjs`（目标改成「落到自己的目录 + 返回路径」） |
| 诊断：有界环、只记分类码、不记内容 | 采纳，重写为 `diag.mjs`（码表自带在导出里） |
| 端口占用自动让位、进程崩溃自我恢复 | 采纳：`listenWithRetry` + 上游连续失败自动重铸 cookie |
| 弱网退避、断线重连 | 采纳：中继 WS、同步 WS、SSE 各自退避 |

**它做了但我们不做（前提不同）：**

- **把 Tailscale 内核编进 APK**。PWA 装不进 VPNService。我们的替代：插件侧打 Tailscale 地址提示，或自建中继。
- **App 专用 VPN、MagicDNS 下发**。同上，需要原生壳。
- **在手机 127.0.0.1 起 TCP 监听做回环穿透**。PWA 没有进程能监听端口 → 换成页面侧 shim + 服务端 `/loop/<port>`
  （只覆盖 fetch/XHR/WS，不覆盖 `<img src>`）。
- **原生通知栏审批按钮、主屏小组件、应用内更新**。PWA 用 Web Notification；要系统级能力只能另做壳。

**我们自己长出来的：**

- **双端同步的 `rpcId` 对账**（§8）——参考实现是「同一台电脑的镜像」，不存在两个输入端，所以没有这个问题。
- **中继拨出模型**（电脑主动连出、手机连入，房间号会合）——它用现成 VPN 网段，省了这层。
- **零依赖的 WS 客户端 / 服务端**（`ws-client.mjs`、`relay/server.mjs`）——为了「装完就能跑」这条底线。

## 数据落点

| 位置 | 内容 | 权限 |
|---|---|---|
| `$DSH_HOME/pocket.json` | `secret`、当前配对码、已配对设备、中继配置 | `0600` |
| 手机 `localStorage` | `dshpocket.*`：地址、令牌、设备名、中继、通知开关 | 浏览器同源作用域 |
| 中继内存 | 房间号 → 密钥派生 token、host/client 套接字 | 进程内 |

配对成功即轮换配对码；`secret` 换了等于全部设备下线。

## 测试为什么这样切

- `store.test.mjs` —— 纯逻辑：配对、锁定、令牌、重读落盘。
- `stack.test.mjs` —— 真起 `http.Server`，后面挂 `test/helpers/fake-dsh.mjs`（只实现三道栅栏与三个 RPC）。
  打的是不变式，不是实现细节，所以重构内部不会假红。
- `pwa.test.mjs` —— 静态检查：DOM id 引用、写死地址、API 路径是否都在协议里、SW 是否旁路 `api/`。
- `follow.test.mjs` —— 同步状态机：假传输手动推帧（帧形状来自真机探针），断言「手机最终看到什么」。
- `features.test.mjs` —— 回环、续传、诊断的 HTTP 面。
- `relay.test.mjs` —— 真子进程 + 三条真 WebSocket（Node 22+ 自带客户端）。

`createStack()` 让插件入口与测试/standalone 共用一条装配路径：装配一旦分叉，
就会出现「测试里好的、装进 dsh 里坏的」这类最难查的 bug。