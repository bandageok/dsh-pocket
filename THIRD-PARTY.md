# 第三方组件与来源

本仓库**不包含**任何第三方二进制（0.4.0 起移除了内置的 Tailscale 引擎与 `gomobile` 生成的 AAR）。

| 依赖 | 许可 | 用途 |
|---|---|---|
| Node.js 内置模块 | — | 插件、中继、工具脚本（零 npm 依赖） |
| AndroidX（core-ktx / appcompat / activity / webkit） | Apache-2.0 | 原生壳 |
| Android SDK | — | 构建 |

## 设计参考（未复制代码）

[just-a-FA-for-name/DSHgo](https://github.com/just-a-FA-for-name/DSHgo)（MIT）：
本项目早期参考过它的「手机端直连 dsh」思路与界面组织，但**没有复制代码**；
它内置 Tailscale 的做法在 0.4.0 被评估后放弃（原因见 [README](README.md#为什么不做内置-tailscale曾经的方案已移除)）。

## 我们自己的代码

`plugin/`、`plugin/lib/pwa/`、`relay/`、`android/app/src/main/java/dev/dshpocket/` 均为 MIT（见 LICENSE）。
