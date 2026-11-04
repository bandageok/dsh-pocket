# dsh-pocket 插件（桌面端）

装法、原理、安全模型都在仓库根的 [README](../README.md) 与 [docs/](../docs)。这里只放
「装进 dsh 之后你立刻会遇到的东西」。

## 装

```sh
dsh plugin --profile web add github:<you>/dsh-pocket/plugin
# 或本地：
dsh plugin --profile web add /path/to/dsh-pocket/plugin
```

**装完必须重启 `dsh web`** —— 后端半只在启动时挂载。不重启的话端口不会开，手机连不上。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-pocket
  config:
    port: 3081              # 对外端口，被占自动往后试 10 个
    bind: '0.0.0.0'         # 只想本机隧道拨入就填 127.0.0.1
    approvals: observe      # observe = 手机上只看得到；answer = 手机可以批准
    approvalTimeoutMs: 45000
    relayUrl: ''            # 例 wss://relay.example.com
    relayRoom: ''           # 例 my-dsh-7f3a
    loopPorts: []           # 回环穿透白名单，例如 [9230]；空 = 关闭
    loopAny: false          # true = 任意本地端口（危险，见 docs/SECURITY.md）
```

环境变量：`DSH_POCKET_DISABLE=1` 让插件完全不启动（排障用）。

## 启动日志

```
┌─ dsh-pocket ────────────────────────────────────────────────
│ 手机端：http://192.168.1.9:3081/__pocket__/
│ 隧道：http://100.101.102.103:3081/__pocket__/（Tailscale 地址，不在同一 WiFi 时用）
│ 配对码：483920   ·  审批仅展示
│ 完整界面：http://192.168.1.9:3081/?pocket=<配对后的令牌>
└─────────────────────────────────────────────────────────────
```

配对码每次配对成功后轮换；想立刻换一个：删 `$DSH_HOME/pocket.json`。

## 状态文件

`$DSH_HOME/pocket.json`（`0600`）：`secret`、当前配对码、已配对设备、中继配置。
删掉它 = 重新生成密钥 = 所有手机下线。

## 自测

```sh
cd plugin
node --test "test/**/*.test.mjs"      # 22 条，零依赖
node tools/standalone.mjs --dsh-port 3080 --token <launch token>   # 不装进 dsh 试运行
```