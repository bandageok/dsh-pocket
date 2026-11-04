# dsh-pocket

**把 DeepSeek Harness (dsh) 装进口袋：人在外面，用手机看会话在跑什么、发一句指令、把它停下。**

三件东西，全部零依赖、MIT：

| 部件 | 是什么 | 运行时 |
|---|---|---|
| `plugin/` | dsh 插件：把只监听 `127.0.0.1` 的 `dsh web` 变成手机能打开的东西，并对外提供一套手机 API | 跑在 dsh 进程里，Node ≥ 22 |
| `plugin/lib/pwa/` | 手机端 PWA：会话列表、状态、发指令、停止、审批、后台通知 | 手机浏览器，可「添加到主屏幕」 |
| `relay/` | 可选中继：电脑拨出去，手机连进来，**不在同一网段也能用**，不需要公网 IP | 任何能跑 `node server.mjs` 的地方 |

**不是什么**：不是又一个 DSH 前端。历史记录、逐字流式输出仍然看官方界面 —— PWA 里一键打开，走同一个反代，不用再登录一次。PWA 只做「手机上真正需要的那几件事」，因为手机上重画一遍聊天界面既慢，也会和上游的 RPC 语义不断打架。

## 两种形态，同一套后端

| 形态 | 装什么 | 谁适合 |
|---|---|---|
| **PWA**（默认） | 什么都不用装：浏览器打开插件给的地址，「添加到主屏幕」 | 只想先用起来；iOS/Android 通用 |
| **原生 App**（Android） | `dist/dsh-pocket-0.1.0-debug.apk`（3.2 MB，debug 签名） | 要**内置 Tailscale 隧道**、要后台收「待审批 / 跑完了」通知 |

两者的界面是同一套 —— 原生壳不重画界面，只补 PWA 做不到的三件事：内置隧道、系统通知、常驻事件流。
详见 [android/README.md](android/README.md)。

## 三步装上

**① 电脑：装插件**

```sh
dsh plugin --profile web add github:<you>/dsh-pocket/plugin
# 或者本地开发：
dsh plugin --profile web add /path/to/dsh-pocket/plugin
```

然后**重启 `dsh web`**。启动日志会打印：

```
┌─ dsh-pocket ────────────────────────────────────────────────
│ 手机端：http://192.168.1.9:3081/__pocket__/
│ 配对码：483920   ·  审批仅展示
└─────────────────────────────────────────────────────────────
```

**② 手机：打开那个地址**（同一 WiFi 即可，不用装 App、不用扫码）

**③ 输入 6 位配对码** → 进主界面。配一次，之后打开就是会话列表。

> 手机端地址也可以手工填：PWA 在任意位置打开后都能改「桌面地址」，所以你可以先在家里开一次，出门后换成 Tailscale 地址或中继。

## 出门在外

电脑在 NAT 后面、没有公网 IP，插件会主动**拨出**到一个中继：

```sh
# 一台有公网的小机器 / 免费容器
node relay/server.mjs          # 默认 :8787，PORT 可改
```

电脑端在 profile 的 `cordis.patch.yml` 里填：

```yaml
- id: dsh-pocket
  config:
    relayUrl: wss://relay.example.com
    relayRoom: my-dsh-7f3a        # 自选，房间号 + 密钥 = 会合凭证
```

手机端在「设置 → 中继」里填同样的 `wss://…` 与房间号，保存即切到 WS 传输（中继没有 SSE，状态改为 3 秒轮询，状态条会变黄）。

不想用中继也行：装 Tailscale，插件会把 `100.64/10` 的地址直接打到启动日志里（`隧道：http://100.x.y.z:3081/__pocket__/`），手机连同一个 Tailnet 即可。

## 双端同步（记录与内容）

**电脑是唯一真相源，手机是镜像 + 输入口。** 不做「两份存储互相覆盖」——手机没有 dsh 引擎，
两份时间线一旦各自追加，合并就是不可判定问题（这正是已归档的
`dsh-android-Conversation-sync` 要处理「改 cwd / 搬目录 / 只增不减合并」那一整类麻烦）。

下行（电脑 → 手机）：

- 插件订阅上游 `session/follow`，把快照与增量事件归一成消息（`user` / `assistant` / `[工具]`）；
- 手机进入会话就有内容，SSE 边推边显示，逐字输出走 `delta`（累计文本）；
- 手机本地缓存一份（IndexedDB），断网也能读；回到会话先渲染缓存再拉网。

上行（手机 → 电脑）：

- 发消息时客户端生成 `requestId`，服务端原样返回；
- 上游把这条消息记进日志后，会带着**同一个 `rpcId`** 回吐（`source.rpcId`）；
- 手机据此把「本地回声」替换成正式消息 —— 自己发的不会出现两条，另一台设备发的也会原样出现。

被过滤掉的：系统提示词（`system/message`，几 KB）、运行时上下文（`runtime-context`）、
以及 `<system-reminder>` 这类注入提醒 —— 它们在日志里角色是 `user`，但不是人打的字。

## 手机上有什么

1. **会话列表** —— 哪个在跑（🟢）、哪个在等审批（🟠）、最近活动多久前，按「有审批 > 运行中 > 最近活动」排。
2. **发指令** —— 底部快速输入条直接发给最近活动的会话；进详情可以选「排队发送」或「打断并插入（steer）」。
3. **停止** —— 二次确认后 `session/cancel`。
4. **审批** —— 手机能看到「哪个工具、要干什么」，桌面开了 `approvals: "answer"` 时可以直接批准/拒绝。
5. **看内容** —— 会话转录（用户/助手/工具行）实时跟随电脑，逐字输出也会流过来；断网读本地缓存。
6. **传文件** —— 「＋ 文件」分块上传，弱网断了接着传（offset 语义），完成后路径自动填进输入框。
7. **打开完整界面** —— 一键跳到电脑端官方 UI（同一个反代，令牌自动换成 cookie）。
8. **排障** —— 设置里一键导出诊断（只有事件码与数字，可安全贴到 issue）。

装上原生 APK 之后还多两条：**内置 Tailscale**（只让本 App 走隧道，其他应用不受影响，需要一份 `libtailscale.aar`，
见 [android/README.md](android/README.md)）与**后台通知**（待审批、会话跑完，标签页被冻结也照推）。

## 实测到什么程度

对 **dsh `0.2.0-rc.2`** 真机跑过（隔离的 `DSH_HOME`，没碰任何现有 profile）：

| 动作 | 结果 |
|---|---|
| 反代首页 + 注入 polyfill | `200`，35 KB，`<title>DeepSeek Harness</title>`，页内带 `data-dsh-pocket` |
| `?pocket=<令牌>` 换 cookie | `303` + `pocket-auth` 与 `dsh-auth-*` 同时下发，随后 `200` |
| `session/list`（经反代） | `{"ok":true,"items":[]}` |
| 建会话 `session/create` | `session-3d83f821-…` 落库，`/__pocket__/api/state` 立刻能看到（`cwd`、`running`、`agentAvailable` 都正确） |
| 发指令 `session/prompt` | `{"accepted":true}`（对真实会话） |
| 对不存在的会话发指令 | `502 {"detail":"session/not-found"}` —— 上游校验真的走到了 |

自动化测试 **55 条**（`plugin/` 51 + `relay/` 4），全部只依赖 Node 标准库；另有手机端自检 72 项：

```
node --test "test/**/*.test.mjs"     # plugin/ 51 条
node --test "test/**/*.test.mjs"     # relay/  4 条
node tools/pwa-smoke.mjs             # 手机端 72 项（Node + 最小 DOM，真跑 app.js）
```

覆盖的关键面：Host/Origin 改写、闸门先于 token 注入、配对码锁定、`session/prompt` 的参数形状
（`args.request.content[]`）、SSE 首帧、未鉴权 WS 升级被 401、`?pocket=` 三跳 cookie、
中继的 req/res 往返与 host 离线快速失败、同步归一化（含注入提醒过滤）、逐字 `delta` 语义、
断线重连后重挂会话、续传的 offset 语义与 finish 不重放、回环白名单默认关闭。

## 目录

```
dsh-pocket/
├── plugin/
│   ├── lib/
│   │   ├── index.js       # cordis 入口：apply(ctx, config)，只碰 ctx.webServer / ctx.connection
│   │   ├── stack.mjs      # 装配：反代 + 手机 API + PWA，插件与测试共用同一条路径
│   │   ├── proxy.mjs      # Host/Origin 改写、launch token 注入、页面 shim、WS 穿透
│   │   ├── pocket.mjs     # /__pocket__/api/*：快照、prompt、cancel、approval、SSE、路由
│   │   ├── follow.mjs     # 双端同步：订阅 session/follow、归一化、断线重挂
│   │   ├── ws-client.mjs  # 零依赖 WS 客户端（上游要 cookie，标准 API 传不了头）
│   │   ├── loop.mjs       # 回环穿透：/__pocket__/loop/<port>（白名单，默认关闭）
│   │   ├── upload.mjs     # 断点续传：init / chunk(offset) / finish，磁盘上限 + TTL
│   │   ├── diag.mjs       # 有界诊断环：只有事件码与数字
│   │   ├── upstream.mjs   # 对 127.0.0.1:<dsh port> 的 RPC 客户端（cookie 铸造 + 401 重取）
│   │   ├── gate.mjs       # 访问闸门（Bearer / cookie / ?pocket=）
│   │   ├── store.mjs      # ~/.dsh/pocket.json：密钥、配对码、设备、中继
│   │   ├── relay.mjs      # 中继拨号
│   │   └── pwa/           # 手机端（原生 JS，无构建）
│   ├── tools/
│   │   ├── standalone.mjs # 不装进 dsh 也能跑（调试用）
│   │   ├── probe-follow.mjs # 真机探针：验同步链路、打印上游帧形状
│   │   └── pwa-smoke.mjs  # 手机端自检：Node + 最小 DOM 真跑 app.js（72 项）
│   └── test/
├── android/             # 原生壳（Kotlin）：WebView + 内置 Tailscale + 通知服务
├── dist/                # 编好的 debug APK
├── relay/server.mjs     # 中继（自己实现 RFC6455 最小子集，零依赖）
└── docs/                # PROTOCOL / ARCHITECTURE / SECURITY / TROUBLESHOOTING
```

## 开发

```sh
cd plugin && node tools/standalone.mjs --dsh-port 3080 --token <launch token>
```

`--token` 可以从 `dsh web` 的启动日志里抄：`http://127.0.0.1:3080/?token=…`。这样改一行代码就能看效果，不用重启 dsh。

## 已知限制（诚实清单）

- **不是 APK**。PWA 免安装、iOS/Android 通用，代价是：iOS 上通知要「添加到主屏幕」才可用；后台被系统冻结时收不到推送（v0.1 没有 Push）。
- **审批默认只展示**。要让手机能批准，得在 profile 里设 `approvals: "answer"`；此时如果桌面端 UI 也开着，手机可能先接住（插件比 UI 更早注册 waterfall）。超时（默认 45 s）会交回桌面。
- **同步范围是「你打开的会话」**。看哪个才订阅哪个（5 分钟没人看自动退订），不会把电脑上全部历史拉到手机。
- **离线只读**。断网时能读缓存，发出去的消息要等连上才生效（没有离线队列）。
- **中继看得到明文**。它只按 id 配对请求/响应，不解析业务，但内容经过它。所以默认建议自建，别用陌生人的公共中继。
- **`?pocket=` 会把令牌带进地址栏**。只在你自己的设备上打开；令牌换了就失效。
- **一台电脑一个反代端口**。多 profile 并存时每个 profile 各给一个端口（`port` 配置）。

## 路线图

- [ ] 会话历史（`session/follow` 的 snapshot + assistant-stream 帧）
- [ ] Push（自建 WebPush，让 app 在后台也能收到「跑完了 / 等你审批」）
- [ ] 安卓 WebView 壳（PWA 已经能装，壳只为了拿到系统级通知与常驻连接）
- [ ] 中继端到端加密（房间密钥派生 XChaCha20，中继只剩密文）
- [ ] 多机管理（一个手机连多台电脑，按机器切换）

## License

MIT。`docs/PROTOCOL.md` 里的上游事实来自对 dsh `0.2.0-rc.2` 的实测与源码，不是官方承诺 —— dsh 换版本时以实测为准。