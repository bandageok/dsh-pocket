# 第三方组件与来源

本仓库的 `android/app/libs/libtailscale.aar` 是**构建产物**，不是手工代码。它由以下开源项目生成：

| 组件 | 许可 | 用途 | 来源 |
|---|---|---|---|
| [tailscale](https://github.com/tailscale/tailscale)（`libtailscale` 包） | BSD-3-Clause | 进程内 WireGuard / 登录 / MagicDNS 引擎（Go） | `gomobile bind` 自 `tailscale/tailscale-android` 的 `libtailscale` 包 |
| [gomobile](https://go.dev/wiki/Mobile)（`golang.org/x/mobile`） | BSD-3-Clause | Go ↔ Java 绑定生成器、`go.Seq` 运行时 | `go install golang.org/x/mobile/cmd/gomobile` |
| [tailscale-android](https://github.com/tailscale/tailscale-android) | BSD-3-Clause | Android 侧的工程结构与 VpnService 约定 | 上游仓库 |

重新生成（不需要提交 AAR 也能理解它是怎么来的）：

```powershell
pwsh scripts/build-libtailscale.ps1 -Goproxy https://goproxy.cn
# → android/app/libs/libtailscale.aar（arm64 + arm）
```

## 设计参考（未复制代码）

- [just-a-FA-for-name/DSHgo](https://github.com/just-a-FA-for-name/DSHgo)（MIT）：本项目的
  「内置 Tailscale + 应用专用隧道 + localapi 驱动」这套结构参考了它，接口清单与它踩过的坑
  记录在 [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md)。
  代码是按它公开的接口约定重写的，没有逐行复制；差异见该文档末节。

## 我们自己的代码

`lib/`、`plugin/lib/pwa/`、`relay/`、`android/app/src/main/java/dev/dshpocket/` 均为 MIT（见 LICENSE）。
其中 Android 的 `net/AppContextImpl.kt`、`net/TailnetService.kt`、`net/Tailnet.kt` 是按
`gomobile` 生成的接口（`libtailscale.AppContext` / `IPNService` / `VPNServiceBuilder`）实现的，
接口本身属于上面的 BSD-3 组件。