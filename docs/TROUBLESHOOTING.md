# 故障排查

按症状查。每条都写「怎么确认」而不是「大概是什么」。

## 手机上打不开 `http://<IP>:3081/__pocket__/`

1. **确认端口真的在监听**
   ```sh
   # 电脑上
   curl -s http://127.0.0.1:3081/__pocket__/health
   ```
   连本机都不通 → 插件没起来。看 `dsh web` 的终端输出里有没有 `dsh-pocket` 那几行。
   常见原因：`--dump-config` / headless 场景没有 `webServer`，插件会打印「拿不到 dsh web 端口」并退出。

2. **确认手机和电脑在同一网段**
   手机浏览器打开 `http://<IP>:3081/__pocket__/health` 应看到 JSON。
   不通就是网络层：Windows 防火墙、AP 隔离（很多公司/酒店 WiFi 默认开）、VPN 抢占路由。

3. **确认绑定地址**
   `bind: 127.0.0.1` 时只有本机能连 —— 这是**故意的**保守配置，别为此改成 `0.0.0.0` 了事，先确认你是要走隧道还是中继。

## 打开了，但一直 401

```
dsh-pocket: unauthorized — pair this device first
```

- 令牌被清过（换浏览器、清缓存、隐私模式）→ 回连接屏重新配对。
- `pocket.json` 被删/换过（secret 变了）→ 所有旧令牌立刻失效，这是设计行为。
- 反过来：想主动踢光所有设备，就是删 `pocket.json`。

如果 401 的响应体是 **`dsh web authentication required`**（不是我们那句），说明请求绕过了反代直达上游 ——
检查你填的地址是不是 `:3080`（那是 dsh 自己的口，不是插件的）。

## 能打开界面，但发消息没反应 / 一直转圈

这是 **polyfill 缺失**的经典症状。确认：

```sh
curl -s -H 'accept: text/html' http://127.0.0.1:3081/ | grep -c data-dsh-pocket
```

返回 `0` 说明注入没生效。可能原因：

- 请求没走反代（见上一条）。
- 上游改了首页结构（`<head>` 变了）。`injectPolyfill()` 会退化为插到最前面，仍应注入成功；真没注入就看 `proxy: html decode failed` 日志 —— 说明上游用了我们不认识的 `content-encoding`。

## 实时状态不刷新 / 审批不弹

1. **看状态条颜色**：绿 = SSE 在线，黄 = 轮询降级，红 = 断线。
2. 黄是**正常**的（中继模式没有 SSE）。直连模式下变黄，说明 SSE 连续失败 3 次，客户端会每分钟尝试回绿。
3. SSE 本身被中间设备掐断（某些代理会缓冲流）：反代已经设了 `x-accel-buffering: no`，但如果你前面还有一层 Nginx，需要 `proxy_buffering off;`。
4. 审批只有 **45 秒展示窗**（`observe` 模式下桌面答完后插件并不知道），消失不代表出错。

## 发指令返回 409 / 502

| 返回 | 含义 | 处理 |
|---|---|---|
| `409 agent-busy` | 用了 `steer` 但当前没有可插入的回合 | 改用「排队发送」 |
| `502 session/not-found` | 会话已删 | 刷新列表 |
| `502 session/model-unavailable` | 上游没配模型/凭据 | 在电脑上先跑通一次 |
| `502 upstream` + `launch token unavailable` | `ctx.connection.authenticatedUrl` 取不到 token | dsh 版本太老（< 0.1.2）或连接层换了 API |

## 中继连不上

```
relay: register failed (403)   → 房间号已被别的 secret 占用，换一个
relay: disconnected, retry…    → 中继没起来 / wss 证书不对 / 房间号写错
手机：host 离线              → 桌面插件的 relay 没连上（看插件日志），或房间号不一致
```

自检：

```sh
curl -s https://<relay>/relay/health          # {"ok":true,"rooms":1,"hosts":1}
```

`hosts: 0` 表示电脑没连上来 —— 检查插件日志里的 `relay:` 行。

## 端到端检查（用来分辨「谁坏了」）

```sh
# 1. 上游活着吗
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/          # 401 = 活着（栅栏）

# 2. 反代活着吗
curl -s http://127.0.0.1:3081/__pocket__/health

# 3. 上游 RPC 通吗（要令牌）
curl -s -H "Authorization: Bearer <token>" \
     "http://127.0.0.1:3081/__pocket__/api/state?force=1" | head -c 300

# 4. 隔离跑一份（完全不碰现有 profile）
cd plugin && node tools/standalone.mjs --dsh-port 3080 --token <launch token>
```

`--token` 从 `dsh web` 启动日志的 `http://127.0.0.1:3080/?token=…` 里抄。

## 插件装完 `dsh web` 起不来

最常见的是**同一个插件被挂两次**（`cordis.patch.yml` 里重复了，或市场安装与手工安装叠加）。
症状是启动即失败、报 locale/服务重复注册。

```sh
dsh plugin --profile web remove dsh-pocket
# 检查 profile 的 cordis.patch.yml 里 dsh-pocket 只出现一次，再重新 add
```

## 端口被占

插件默认 `3081`，被占会自动往后试 10 个（启动日志打印实际端口）。
也可以显式改：

```yaml
- id: dsh-pocket
  config:
    port: 3181
```

## 需要更多日志

插件用 `console` 打日志（和 `dsh web` 自己一致），所以重启时把输出留下来即可：

```sh
dsh --profile web --no-open 2>&1 | tee /tmp/dsh-web.log
```

日志里有意**不含**令牌全文（`upstream.mjs` 只打印 cookie 前 16 字节），贴 issue 时不用二次脱敏 ——
但地址、房间号请自己糊掉。

## 「在外面（不同网络）连不上」

先分清三条通路，**只有后两条能跨网络**：

| 通路 | 前置条件 | 不满足时的表现 |
|---|---|---|
| 局域网直连 | 手机与电脑同一网段（本机是 `10.103.0.0/16`） | 点「测试」→ **超时** |
| 内置 Tailscale | ① 手机 App 里登录了 Tailscale ② **电脑也装了 Tailscale 并登录同一账号** ③ 插件在跑 | 隧道能连上，但「找不到电脑」 |
| 中继 | 一台有公网 IP 的机器跑 `relay/server.mjs`，两端填同样的 `relayUrl/relayRoom` | 手机设置里没填 → 走不通 |

排查顺序（每条都有一句命令）：

1. **电脑上到底在不在 tailnet**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tailnet-info.ps1
   ```
   没装 → `winget install --id Tailscale.Tailscale`；装了但没登录 → 点托盘图标 → *Log in…*。
   它会直接打印手机该填的地址 `http://100.x.y.z:3081/__pocket__/`。
2. **插件在那个地址上答不答**（同一个脚本会测）：答不上就是插件没跑/端口不对，
   与网络无关。
3. **手机端是否登录**：App 里「启动隧道」后状态应离开 `NeedsLogin`；停在 `NeedsLogin`
   说明授权页没走完。
4. **账号是否同一个**：两端不同账号 → 永远看不见对方。

### 为什么手机登了、电脑没装就一定连不上

内置 Tailscale 只把**手机**放进一个私有网络（tailnet）。电脑不在这个网络里，
手机就没有任何节点可连——它不是穿透服务器，不能说「连到任意电脑」。
参考实现（DSHgo）的 README 也是同一个前提：PC 侧必须装 Tailscale 并登录。

### 电脑加入 tailnet 之后

- 插件监听 `0.0.0.0:3081`，天然覆盖 tailnet 网卡，不用改配置；
- 本机防火墙三个 profile 都是关闭的，所以不用额外放行；
- 手机端「启动隧道」→ 自动扫在线 peer 的 3081 → 找到电脑 → 直接打开。

## 电脑端 tailscaled 起不来（Windows，实机踩过）

症状：托盘「Log in」点了没反应；`tailscale status` 无输出；命名管道里没有 tailscale。

证据（`tailscaled --windows-mode=dev` 手动跑出来的）：

```
winhttp: Open: The parameter is incorrect.
tshttpproxy: winhttp: GetProxyForURL("https://controlplane.tailscale.com/"): ERROR_INVALID_PARAMETER
creating dns cleanup: Invalid class string
```

诊断要点：**服务在跑 ≠ 后端在跑**。`Get-Service Tailscale` 显示 Running 也可能永远没有
`\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`，这时任何 CLI 命令都连不上，
GUI 的 Log in 也没有反应。

> 这台机器**没装 PowerShell 7**（没有 `pwsh`），一律用自带的 5.1：
> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-tailscale.ps1 -NoElevate`，或直接双击 `scripts\fix-tailscale.cmd`。

一键修：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-tailscale.ps1`（自带提权：重启服务 → 等管道 → 取授权链接 →
开浏览器 → 登录后打印 100.x 与插件连通性）。仍不行就重启一次机器，再跑该脚本。

## 手机端点「Sign in with Google」没反应

Google 明确禁止在 WebView 里做 OAuth（`disallowed_useragent`）。所以 App 的登录页
**必须交给系统浏览器**；小米自带浏览器也可能拦第三方登录，装 Chrome 后在 Chrome 里打开
授权链接即可。

另外：不要反复调 `login-interactive` —— 每次调用都会**重新生成 node key**，
旧链接立刻失效，页面会报 `Error 400 — missing machine key`。App 里已改成只踢一次。

## 「在外面操控」的推荐路线（实测可用，2026-11-05）

**结论：用 Cloudflare 快速隧道，不要用 Tailscale。** 这台 Windows 上 Tailscale 的服务后端
起不来（`creating dns cleanup: Invalid class string` → 托盘 "Failed connecting to the Tailscale
service"、CLI 503 no backend，卸载重装无效），属于系统 COM 组件损坏，不是配置问题。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts	unnel-outside.ps1          # 起隧道，打印地址+配对码
powershell -NoProfile -ExecutionPolicy Bypass -File scripts	unnel-outside.ps1 -Status # 只看当前地址
powershell -NoProfile -ExecutionPolicy Bypass -File scripts	unnel-outside.ps1 -Install # 登录自启
```

实测（公网地址上）：`health` 200、配对拿 token、`/api/state` 返回 54 个会话、
未授权 401。手机在 5G 下打开 `https://<随机>.trycloudflare.com/__pocket__/` 即可。

注意事项：
- **地址每次重启隧道都会变**，当前值保存在 `%LOCALAPPDATA%\DshPocket\public-url.txt`；
- 流量经 Cloudflare **明文转发**，安全边界是插件的配对码 + 设备令牌（不是端到端加密）；
- 长期稳定用的话换成带域名 + Cloudflare Access 的**命名隧道**（需要 Cloudflare 账号）；
- 这台机器上 `Invoke-RestMethod` 访问公网 HTTPS 会卡在证书吊销检查（连不上微软 CRL），
  脚本里已改用 `curl.exe --ssl-no-revoke`。

