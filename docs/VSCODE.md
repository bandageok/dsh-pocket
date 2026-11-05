# 在 VS Code 里测试

前提：这些都已经在这台机器上装好了 —— JDK 17（`D:\Java`）、Android SDK（`C:\Android\sdk`，
含 `platform-tools` / `emulator` / `android-34` / `x86_64` 系统镜像）。

## 一、打开项目

```powershell
code "C:\Users\OK bandage\Documents\deepseek-harness\default-workspace\dsh-pocket"
```

VS Code 里 `Ctrl+Shift+P` → **Tasks: Run Task**，任务列表就是我配好的十项
（[.vscode/tasks.json](../.vscode/tasks.json)）。全部走集成终端，不依赖任何 Android 扩展。

## 二、最快的两条路

### A. 只看手机界面（模拟器，20 秒）

1. Run Task → **① 构建 APK（x86_64，给模拟器）** —— 模拟器是 x86_64，引擎的 `.so` 要对应架构
2. Run Task → **⑩ 一键：模拟器全流程** —— 它会依次：启动模拟器 → 等 boot 完成 → 装机 → 启动 → 挂日志

界面在无窗口模式下看不到，用 **⑦ 截图到 shots/** 抓一张，或者在任务 ③ 里去掉
`-no-window` 直接看窗口。

### B. 只看后端（不需要模拟器）

Run Task → **⑧ 后端测试**：插件 52 条 + 手机端自检 72 项 + 中继 4 条。

## 三、手机连电脑这一条，在模拟器里怎么测

模拟器里 `10.0.2.2` 就是**宿主机**，所以：

- App 地址栏填 `10.0.2.2:3081`（或完整 `http://10.0.2.2:3081/__pocket__/`）
- 点「连接」→ 应该看到配对页
- 配对码：插件启动时打印的那个，也可以直接读
  ```powershell
  node -e "console.log(JSON.parse(require('fs').readFileSync('C:/Users/OK bandage/.dsh/pocket.json','utf8')).code)"
  ```
- 配对后就能看到真实会话列表（SSE 在线），点进去能看转录、发指令

> 模拟器里**隧道不能登真账号**（我没账号，你也不该在模拟器里登生产账号）。
> 能验到的是：VPN 授权弹窗 → 引擎注册 controlplane → 返回授权链接，到此为止。

## 四、真机怎么测

1. 手机开「开发者选项 → USB 调试」，插上 USB，`adb devices` 应能看到设备
2. Run Task → **① 构建 APK（arm64，给真机）**（真机是 arm64）
3. 手动装：
   ```powershell
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```
   （任务 ⑤ 里写死了 `-s emulator-5554`，真机就把 `-s` 去掉或换成设备序列号）
4. 看日志：`adb -s <序列号> logcat -s DshPocket`

## 五、两个 VS Code 相关的小坑

- **PowerShell 脚本里的中文**：Windows PowerShell 5.1 按 ANSI 读 `.ps1`，中文注释会让它
  解析失败（报 `UnexpectedToken`）。仓库里的 `.ps1` 都是 **UTF-8 带 BOM**，改的时候别丢 BOM。
  或者干脆用 `pwsh`（PowerShell 7）跑。
- **终端中文乱码**：git-bash 里 `node` 输出中文会变成 GBK 乱码，那是控制台编码，不是文件坏了。
  验证文件内容用 `node -e "console.log(require('fs').readFileSync('x','utf8'))"`。

## 六、任务一览

| 任务 | 干什么 |
|---|---|
| ① 构建 APK | `assembleDebug` |
| ⑥ 截图 | 存到 `shots/` |
| ⑧ 后端测试 | 插件 + 手机端自检 + 中继 |
| ⑨ 隧道模拟 | 真中继 + 真拨号 + 手机侧帧（需 `POCKET_TOKEN`） |
| ⑩ 一键全流程 | ②③④⑤⑥ 串起来 |