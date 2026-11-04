# dsh-pocket 协议

手机（PWA）↔ 桌面（dsh 插件）之间的契约。所有实现必须以此文件为准；改动协议先改这里。

版本：`v0.1`（2026-11-04）

## 0. 三层

```
手机 PWA  ──① LAN / 隧道（HTTP+SSE）──▶  插件代理 :3081  ──② 回环改写 ──▶  dsh web :3080
    │                                        
    └────③ 中继（WS，可选，为不在同一网段时用）──▶ 中继服务 ──WS──▶ 插件代理
```

- ① 与 ③ 只差传输层，**路径、方法、JSON 体完全一致**，所以手机端只有一个 `rpc(path, body)`。
- ② 是插件内部对 `dsh web` 的反向代理：把 `Host`/`Origin` 改写成 `127.0.0.1:<dshPort>`，并在首屏注入一次 launch token。DSH 的 `/api` 有 Host/Origin 栅栏、会话 cookie 绑 authority，这两步不做就是 401。

## 1. 认证

- 桌面首次启动生成 `secret`（32 字节，写入 `~/.dsh/pocket.json`，权限 0600）与 6 位**配对码**（打印在启动日志与 PWA 首屏）。
- 手机 `POST /__pocket__/pair {code}` 拿到 `token = HMAC-SHA256(secret, "device:" + deviceId)` 与 `deviceId`。
- 之后每个请求带 `Authorization: Bearer <token>` 或 cookie `pocket-auth=<token>`。
- 配对码连错 5 次锁 5 分钟（`429`）。配对码可用 `pocket.json` 里的 `rotate` 或重启插件轮换。
- **闸门必须先于 token 注入**：注入 launch token 等于已登录，顺序反了鉴权就是摆设。

## 2. 公开端点（免鉴权）

### `GET /__pocket__/health`

```json
{
  "ok": true,
  "name": "dsh-pocket",
  "version": "0.1.0",
  "paired": true,
  "upstream": { "port": 3080, "ready": true },
  "transport": { "lan": true, "relay": null }
}
```

`paired=false` 表示还没有任何设备配对过。`upstream.ready` 由插件对 `127.0.0.1:<dshPort>/` 的一次探测决定（401/200 都算 ready，连接失败才算 false）。

### `POST /__pocket__/pair`

请求 `{ "code": "123456", "name": "iPhone" }`

- `200` → `{ "token": "…", "deviceId": "…", "deviceName": "iPhone" }`
- `401` → `{ "error": "bad-code", "attemptsLeft": 4 }`
- `429` → `{ "error": "locked", "retryAt": 1793809999 }`
- `400` → `{ "error": "bad-request" }`

## 3. 需要鉴权

失败一律 `401 {"error":"unauthorized"}`。

### `GET /__pocket__/api/state`

全量快照，PWA 的**唯一真相源**。

```json
{
  "now": 1793805601,
  "sessions": [
    {
      "id": "session-…",
      "short": "c26c7dcb",
      "running": true,
      "agentAvailable": true,
      "updatedAt": 1793805590,
      "lastActivityAt": 1793805588,
      "cwd": "C:\\work\\proj",
      "title": null,
      "parent": null,
      "origin": null,
      "approvals": [
        { "id": "apr-1", "tool": "bash", "reason": "run tests", "createdAt": 1793805585 }
      ]
    }
  ],
  "approvals": [
    { "id": "apr-1", "sessionId": "session-…", "tool": "bash", "reason": "run tests", "createdAt": 1793805585 }
  ],
  "devices": [ { "id": "…", "name": "iPhone", "lastSeenAt": 1793805599 } ],
  "capabilities": { "approvalAnswer": false }
}
```

- `title` 允许为 `null`：DSH 的 `session/list` 不带标题，插件不为此去激活会话。
- `lastActivityAt` 来自 `api-session/activity` 事件；没有就回落 `updatedAt`。
- `capabilities.approvalAnswer` 表明桌面是否开启了「手机上批准」（`approvals: "answer"`），关着时 PWA 只展示审批、不显示按钮。

### `POST /__pocket__/api/prompt`

`{ "sessionId": "session-…", "text": "跑一下测试", "mode": "queue" }`（`mode` 缺省 `queue`；`steer` 用于打断当前步插入）

- `200` → `{ "accepted": true }`
- `409` → `{ "error": "agent-busy" }`（`steer` 被拒）
- `502` → `{ "error": "upstream", "detail": "…" }`

上游调用（已实测，dsh 0.2.0-rc.2）：

```
POST /api/session/prompt
{"type":"client-request","rpcId":"<id>","method":"session/prompt",
 "payload":{"args":{"request":{"requestId":"<uuid>","sessionId":"…","mode":"queue",
                              "content":[{"type":"text","text":"跑一下测试"}]}}}}
```

### `POST /__pocket__/api/cancel`

`{ "sessionId": "session-…" }` → `{ "ok": true }`。走上游 `session/cancel`。

### `POST /__pocket__/api/approval`

`{ "approvalId": "apr-1", "decision": "allow" }`（`decision`: `allow` | `deny`）

- `200` → `{ "ok": true }`
- `404` → `{ "error": "gone" }`（已被桌面端答掉或超时）
- `403` → `{ "error": "approval-answer-disabled" }`

### `GET /__pocket__/api/stream`（SSE）

```
event: state
data: {"…与 /api/state 同构…"}

event: approval
data: {"id":"apr-1","sessionId":"…","tool":"bash","reason":"…","createdAt":1793805585,"state":"pending"}

event: approval-resolved
data: {"id":"apr-1","outcome":"allowed-once"}

: ping
```

- 每 3 秒推一次 `state`（有变化才推），15 秒一次心跳注释。
- 客户端断线重连用 `Last-Event-ID` 不要求支持：重连即拿全量快照。

## 4. 中继（可选）

本地网络打不通时用。中继只转发帧、不解密业务语义——**它看得到明文**，所以默认只推荐自建。

- 桌面：`POST /relay/register {room, secret}` → 收到 `roomToken`；随后 `WS /relay/host?room=<room>&token=<roomToken>` 拨出并保持。
- 手机：`WS /relay/client?room=<room>`（房间存在且 host 在线才 101）。
- 帧格式（两个方向对称）：

```json
{"t":"req","id":1,"path":"/__pocket__/api/state","method":"GET","headers":{"authorization":"Bearer …"},"body":null}
{"t":"res","id":1,"status":200,"headers":{"content-type":"application/json"},"body":"{\"now\":…}"}
{"t":"host","online":true}
{"t":"ping"} / {"t":"pong"}
```

`body` 一律字符串（已 JSON 化）。中继不认识 `path`，只按 `id` 配对请求与响应；单房间单 host、多 client。

## 5. 上游不变式（实现时必须守）

| 不变式 | 后果 |
|---|---|
| `Host` 与 `Origin` 每次改写成同一个 `127.0.0.1:<dshPort>` | cookie 绑 authority，换写法就换身份 → 401 |
| 首屏 `GET /?token=<launch token>` | 不带就拿不到会话 cookie |
| cookie 缓存 + 401 时重取一次 | launch token 每次 `dsh web` 启动都变 |
| `WebSocket` 升级原样双向 pipe（`/api/remote.mux`） | 不 pipe 就只有静态历史、没有实时 |
| 在页面脚本前补 `crypto.randomUUID` / `AbortSignal.any` | 非安全上下文/旧 WebView 下能打开但发不出消息 |
| 鉴权闸门早于 token 注入 | 顺序反了等于没有鉴权 |
## 6. v0.2 增量：内容同步 / 上传 / 回环 / 诊断

本节是 v0.2 新增能力的契约。与前面冲突时以本节为准。

### 6.1 `GET /__pocket__/api/session/:id/messages`

把某个会话的**记录与内容**同步给手机（双端同步的下行）。

查询参数：`wait`（毫秒，等首次快照的最长时间，默认 1500）、`limit`（预留）。

```json
{
  "sessionId": "session-…",
  "cursor": 9,
  "streaming": "",
  "messages": [
    { "seq": 8, "at": 1793807000008, "role": "user", "kind": "message", "text": "跑一下测试", "rpcId": "…", "eventType": "user/message" },
    { "seq": 12, "at": 1793807000012, "role": "assistant", "kind": "message", "text": "结果如上", "rpcId": "", "eventType": "assistant/message" },
    { "seq": 13, "at": 1793807000013, "role": "tool", "kind": "tool", "text": "[bash]", "rpcId": "", "eventType": "tool/call" }
  ]
}
```

- `role`: `user` | `assistant` | `tool` | `other`。`kind: tool` 时 `text` 形如 `[工具名]`。
- 只包含**对话内容**：`system/message`（系统提示词，几 KB）与 `source.kind = runtime-context` 的事件被服务端丢弃。
- 首次调用会触发服务端订阅上游 `session/follow`；上游不可用时返回空数组（不是错误）。
- 5 分钟没人看自动退订（省一条上游 WebSocket 流）。

### 6.2 SSE 扩展

原 `GET /api/stream` 增加查询参数 `session=<id>`：服务端订阅该会话，并额外推四种事件。

```
event: reset          data: {"sessionId":"…","cursor":9,"remaining":{},"messages":[…]}   ← 整段替换
event: message        data: {"sessionId":"…","cursor":10,"message":{…}}                  ← 追加一条
event: delta          data: {"sessionId":"…","text":"你好"}                              ← 累计全文，不是增量
event: sync-error     data: {"code":"gateway/…","message":"…"}
```

`delta.text === ""` 表示这一轮生成结束，手机应清除临时气泡。

### 6.3 `POST /api/prompt` 回 `requestId`

```json
{ "accepted": true, "requestId": "e5be1fcc-…" }
```

手机用它做**去重**：先本地插入一条 `role:user` 的回声（`rpcId = requestId`），随后上游把这条消息
以同一个 `rpcId` 回吐（`source.rpcId`），手机用正式消息**替换**本地条 —— 于是「自己发的」不会出现两条，
另一台设备发的也会原样出现。这就是双端同步的上行。

**模型**：电脑是唯一真相源，手机是镜像 + 输入口。不做两份存储的合并。

### 6.4 断点续传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload/init` | `{name, size, requestId}` → `{id, name, size, offset:0, chunkSize, resumed}`；同 `requestId` 幂等 |
| GET | `/api/upload/<id>` | `{id, name, size, offset, state, sha256}`（断线后用来问「传到哪了」） |
| PUT | `/api/upload/<id>?offset=N` | body 是原始字节（≤8 MiB/块）→ `{offset, size}`；`offset` 不符回 `409 {error:"offset", offset:真实值}` |
| POST | `/api/upload/<id>/finish` | 校验长度 + sha256 → `{ok, path, size, sha256}`；**已完成的再调返回同一结果，不重放** |

限制：单文件 512 MiB、总量 2 GiB、空闲 30 分钟回收，落盘目录 `$DSH_HOME/pocket-uploads/`。

### 6.5 回环穿透

`/__pocket__/loop/<port>/<path>` 转发到电脑的 `127.0.0.1:<port>`（HTTP 与 WebSocket）。
仅对配置里 `loopPorts` 列出的端口生效（`loopAny: true` 才放开全部）；默认关闭。
转发时 `Host`/`Origin` 改写成目标 authority，并剥离手机的 `pocket-auth` cookie 与 `Authorization`。

页面侧注入的 shim 会把 `http://127.0.0.1:<白名单端口>/…` 的 `fetch` / `XHR` / `WebSocket` 改写成上面的路径。
不覆盖 `<img src>` 这类浏览器内建加载（v0.3 再议）。

### 6.6 诊断

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/diag` | `{version, uptimeMs, size, dropped, codes, entries:[{t,c,a,b}]}` |
| GET | `/api/diag?download=1` | JSONL 附件 |

只含事件码与数字（状态码、字节数、端口、条数），**不含**聊天、文件名、路径、IP、令牌。

### 6.7 `GET /__pocket__/health` 新增字段

```json
{
  "version": "0.2.0",
  "uptimeMs": 12345,
  "addresses": ["192.168.1.9", "100.101.102.103"],
  "loop": { "enabled": true, "any": false, "ports": [9230] },
  "upload": { "files": 0, "bytes": 0, "maxFile": 536870912, "maxTotal": 2147483648 },
  "sync": { "sessions": ["session-…"], "connected": true, "tries": 0 },
  "upstream": { "port": 3080, "ready": true, "failures": 0 },
  "diag": 42
}
```

`addresses` 是给手机「自动找电脑」用的：连不上时逐个赛跑，选最快的写回设置。
