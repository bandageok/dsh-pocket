package dev.dshpocket.app

import android.app.Notification
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

/**
 * 本 App 专属的 VPNService —— 「内置 Tailscale」这条路的落地容器。
 *
 * 关键点：`Builder.addAllowedApplication(packageName)`。
 * 加上它，隧道**只承载本 App 的流量**，手机其他应用照旧走 WiFi/移动网络。
 * 这正是参考实现（DSHgo）里说的「应用专用隧道」：用户不会因为装了个远程工具
 * 而整机网络变形，也不需要理解 VPN 是什么。
 *
 * 没有 libtailscale.aar 时这个服务不会被启动（见 TailnetController.mode），
 * 所以它「存在但闲置」是正常状态。
 */
class PocketVpnService : VpnService() {

    private var tun: ParcelFileDescriptor? = null
    private val started = AtomicInteger(0)

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        startForeground(FOREGROUND_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (tun != null) return START_STICKY
        return try {
            val builder = Builder()
                .setSession("dsh-pocket")
                .addAddress("100.64.0.2", 10) // 占位地址：真实地址由 tailnet 分配逻辑覆盖
                .addRoute("100.64.0.0", 10) // 只路由 CGNAT 段（Tailscale 地址空间）
                .addDnsServer("100.100.100.100") // MagicDNS
                .setMtu(1280)
                .setBlocking(false)

            // 只让本 App 走隧道；其他应用不受影响
            try {
                builder.addAllowedApplication(packageName)
            } catch (err: Throwable) {
                Log.w(TAG, "addAllowedApplication 失败（老系统？）：" + err.message)
            }

            tun = builder.establish()
            val fd = tun?.fd ?: run {
                Log.w(TAG, "establish() 返回 null：没有 VPN 授权")
                stopSelf()
                return START_NOT_STICKY
            }
            Log.i(TAG, "隧道已建立，tun fd=$fd")
            TailnetController.handFdToBackend(fd)
            started.incrementAndGet()
            START_STICKY
        } catch (err: Throwable) {
            Log.w(TAG, "建立隧道失败：" + err.message)
            stopSelf()
            START_NOT_STICKY
        }
    }

    override fun onRevoke() {
        Log.i(TAG, "用户或系统撤销了 VPN")
        stopSelf()
        super.onRevoke()
    }

    override fun onDestroy() {
        try {
            tun?.close()
        } catch (_: Throwable) {
        }
        tun = null
        super.onDestroy()
    }

    private fun notification(): Notification {
        val builder = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            Notification.Builder(this, Notifier.CH_STATUS)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("dsh-pocket 隧道")
            .setContentText("仅本 App 的流量经过 Tailscale")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "DshPocket"
        private const val FOREGROUND_ID = 43
    }
}