package dev.dshpocket.app.net

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.OsConstants
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.dshpocket.app.CrashLog
import libtailscale.IPNService
import libtailscale.Libtailscale
import libtailscale.VPNServiceBuilder
import java.util.UUID

/**
 * 内置 Tailscale 的 VpnService —— 结构照搬参考实现（DSHgo 的 `TailscaleVpnService`），
 * 但配置落在我们自己的包名与通知渠道上。
 *
 * 关键点三条，缺一条就会出问题：
 *
 * 1. `addAllowedApplication(packageName)`：**只有本 App 的流量进隧道**，
 *    手机其他应用照旧走 WiFi/移动网络。用户装一个远程工具，不该整机网络变形。
 * 2. `addDnsServer("100.100.100.100")`：MagicDNS。有了它，tailnet 里的机器名能直接解析，
 *    用户不用记 100.x 的 IP。
 * 3. 配置不是我们写的，是**Go 侧通过 `VPNServiceBuilder` 回调要什么就给什么**
 *    （MTU / 路由 / 地址 / DNS）。所以这个类看起来「空」，实际是引擎在驱动它。
 */
class TailnetService : VpnService(), IPNService {

    private val instanceId: String = UUID.randomUUID().toString()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = try {
        handleStart(intent)
    } catch (err: Throwable) {
        // 服务里任何异常都会把进程带走，先记下来，下一次打开 App 会显示原因
        Log.w(TAG, "TailnetService 启动失败：" + err)
        CrashLog.record(this, "TailnetService.onStartCommand", err)
        stopSelf()
        START_NOT_STICKY
    }

    private fun handleStart(intent: Intent?): Int {
        val action = intent?.action
        if (action == ACTION_STOP) {
            try {
                Libtailscale.serviceDisconnect(this)
            } catch (_: Throwable) {
            }
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundSafely()
        // 告诉引擎「VPN 容器已就绪」，它会立刻回调 newBuilder()
        return try {
            Libtailscale.requestVPN(this)
            START_STICKY
        } catch (err: Throwable) {
            Log.w(TAG, "requestVPN 失败：" + err.message)
            stopSelf()
            START_NOT_STICKY
        }
    }

    private fun startForegroundSafely() {
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("dsh-pocket 隧道")
            .setContentText("仅本 App 的流量经过 Tailscale")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        // systemExempted：长跑的 VPN 前台服务，Android 14 不会掐。
        // 但它属于「受限类型」——少数机型/系统策略会直接抛 SecurityException，
        // 这种情况下宁可退成不带类型的前台服务，也不要让用户看到闪退。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED,
                )
                return
            } catch (err: Throwable) {
                Log.w(TAG, "systemExempted 前台服务被拒，退回普通前台服务：" + err.message)
                CrashLog.record(this, "startForeground(systemExempted)", err)
            }
        }
        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (err: Throwable) {
            Log.w(TAG, "startForeground 失败：" + err.message)
            CrashLog.record(this, "startForeground", err)
        }
    }

    // ── libtailscale.IPNService ─────────────────────────────────────

    override fun id(): String = instanceId

    override fun protect(fd: Int): Boolean = super.protect(fd)

    override fun newBuilder(): VPNServiceBuilder {
        val builder = Builder()
            .allowFamily(OsConstants.AF_INET)
            .allowFamily(OsConstants.AF_INET6)
            .addDnsServer("100.100.100.100") // MagicDNS
            .addRoute("100.100.100.100", 32)
        // 失败就失败：宁可不出隧道，也不要建一条影响全机的 VPN
        builder.addAllowedApplication(packageName)
        return TsBuilder(builder)
    }

    override fun close() {
        try {
            Libtailscale.serviceDisconnect(this)
        } catch (_: Throwable) {
        }
    }

    override fun disconnectVPN() {
        stopSelf()
    }

    override fun updateVpnStatus(up: Boolean) {
        Log.i(TAG, "隧道状态：" + if (up) "up" else "down")
    }

    /** 把 Go 侧要的配置落到 `VpnService.Builder` 上。 */
    private class TsBuilder(private val builder: Builder) : VPNServiceBuilder {

        override fun setMTU(mtu: Int) {
            builder.setMtu(mtu)
        }

        override fun addDNSServer(server: String) {
            builder.addDnsServer(server)
        }

        override fun addSearchDomain(domain: String) {
            builder.addSearchDomain(domain)
        }

        override fun addRoute(addr: String, prefix: Int) {
            builder.addRoute(addr, prefix)
        }

        override fun excludeRoute(addr: String, prefix: Int) {
            if (Build.VERSION.SDK_INT >= 33) {
                try {
                    val address = java.net.InetAddress.getByName(addr)
                    builder.excludeRoute(android.net.IpPrefix(address, prefix))
                } catch (_: Throwable) {
                }
            }
        }

        override fun addAddress(addr: String, prefix: Int) {
            builder.addAddress(addr, prefix)
        }

        override fun establish(): libtailscale.ParcelFileDescriptor? {
            val fd: ParcelFileDescriptor = builder.establish() ?: return null
            return object : libtailscale.ParcelFileDescriptor {
                override fun detach(): Int = fd.detachFd()
            }
        }
    }

    companion object {
        private const val TAG = "DshPocket"
        const val ACTION_START = "dev.dshpocket.app.TAILNET_START"
        const val ACTION_STOP = "dev.dshpocket.app.TAILNET_STOP"
        private const val CHANNEL = "status"
        private const val NOTIFICATION_ID = 44

        fun start(context: Context) {
            val intent = Intent(context, TailnetService::class.java).setAction(ACTION_START)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (err: Throwable) {
                Log.w(TAG, "startForegroundService 失败：" + err.message)
                CrashLog.record(context, "startForegroundService", err)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TailnetService::class.java))
        }
    }
}