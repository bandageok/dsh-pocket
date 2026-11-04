package dev.dshpocket.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.util.Log

/**
 * 内置 Tailscale 的三档降级。
 *
 * ## 为什么要三档
 *
 * 「把 Tailscale 编进 App」需要 `libtailscale.aar`（用 tailscale-android 源码经
 * `gomobile bind` 产出，见 android/README.md）。少了这个 AAR，整条隧道就是空的 ——
 * 但 App 不该因此编不过、装不上。所以：
 *
 * | 模式 | 条件 | 行为 |
 * |---|---|---|
 * | EMBEDDED | classpath 上有 `libtailscale.*` | 起本 App 专属的 VpnService，把 tailnet 打通（**只本 App 走隧道**） |
 * | SYSTEM   | 装了官方 Tailscale App | 提示用户打开它；全机 VPN，本 App 一样能用 |
 * | LAN      | 都没有 | 只在同一局域网可用（等价于 PWA 的默认形态） |
 *
 * ## 为什么用反射
 *
 * `libtailscale` 的 Java 面由 gomobile 生成，方法名/签名随上游版本变化。直接
 * `import libtailscale.Libtailscale` 会让「没有 AAR」变成编译错误。反射把不确定性
 * 收进一个文件里，并且**把实际可用的符号打进日志**（`adb logcat -s DshPocket`）——
 * 这样接上 AAR 之后，缺哪个方法一眼能看见，比盲改快得多。
 *
 * 已知的一步需要人工确认：gomobile 出来的后端要拿到 VpnService 的 TUN fd
 * （官方 App 里由 IPNService 提供）。这里的 `PocketVpnService.tunFd` 暴露了 fd，
 * 但具体怎么交给后端，取决于你那份 AAR 的 API —— 日志会把可选方法列出来。
 */
object TailnetController {

    private const val TAG = "DshPocket"

    enum class Mode { EMBEDDED, SYSTEM, LAN }

    fun mode(context: Context): Mode = when {
        hasEmbeddedLibrary() -> Mode.EMBEDDED
        hasSystemTailscale(context) -> Mode.SYSTEM
        else -> Mode.LAN
    }

    fun describe(context: Context): String = when (mode(context)) {
        Mode.EMBEDDED -> "内置 Tailscale（本 App 专属隧道）"
        Mode.SYSTEM -> "系统 Tailscale（请在官方 App 里打开开关）"
        Mode.LAN -> "局域网（未检测到 Tailscale）"
    }

    private fun hasEmbeddedLibrary(): Boolean = try {
        Class.forName("libtailscale.Libtailscale", false, javaClass.classLoader)
        true
    } catch (_: Throwable) {
        false
    }

    private fun hasSystemTailscale(context: Context): Boolean = try {
        context.packageManager.getPackageInfo("com.tailscale.ipn", 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * 尝试把内置隧道拉起来。
     *
     * @return true 表示已发起（不代表已连通——连通的判据是 tailnet 里那个 100.x 地址能访问）
     */
    fun startEmbedded(context: Context): Boolean {
        if (mode(context) != Mode.EMBEDDED) return false

        // ① 先把可用的符号列出来：接 AAR 时这就是说明书
        val api = try {
            val clazz = Class.forName("libtailscale.Libtailscale")
            clazz.methods.joinToString(", ") { it.name + "/" + it.parameterCount }
        } catch (err: Throwable) {
            Log.w(TAG, "libtailscale 不可用：" + err.message)
            return false
        }
        Log.i(TAG, "libtailscale API: $api")

        // ② 申请 VPN 授权（用户要看到系统弹窗，这一步不能跳）
        val intent = VpnService.prepare(context)
        if (intent != null) {
            Log.i(TAG, "需要用户授权 VPN：请回到 App 点一次「启用隧道」")
            return false
        }

        // ③ 起本 App 专属的 VpnService（只把本 App 的流量导进隧道）
        return try {
            context.startService(Intent(context, PocketVpnService::class.java))
            Log.i(TAG, "PocketVpnService 已启动")
            true
        } catch (err: Throwable) {
            Log.w(TAG, "启动 VpnService 失败：" + err.message)
            false
        }
    }

    /**
     * 把后端需要的 tun fd 交给 libtailscale。
     *
     * 这里刻意做成「找不到就只记日志」：签名随 AAR 变化，硬编码会在编译期绑死版本。
     * 接线后（拿到 AAR 的人）只需要在日志里确认方法名，把第一个匹配的分支改成直调即可。
     */
    fun handFdToBackend(fd: Int): Boolean {
        return try {
            val clazz = Class.forName("libtailscale.Libtailscale")
            val candidate = clazz.methods.firstOrNull {
                it.parameterCount == 1 && it.parameterTypes[0] == Int::class.javaPrimitiveType &&
                    (it.name.contains("fd", true) || it.name.contains("tun", true))
            }
            if (candidate == null) {
                Log.w(TAG, "没有找到接收 tun fd 的方法 —— 看上面的 API 列表确认名字")
                false
            } else {
                candidate.invoke(null, fd)
                Log.i(TAG, "已把 tun fd 交给 " + candidate.name)
                true
            }
        } catch (err: Throwable) {
            Log.w(TAG, "交 fd 失败：" + err.message)
            false
        }
    }
}