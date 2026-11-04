package dev.dshpocket.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 通知：审批要你点头、会话跑完要你知道。
 *
 * 这两件事是 PWA 在手机上做不到的（后台标签会被系统冻结），也是「原生壳」存在的唯一理由。
 * 渠道分两个：审批（高优先级、响铃）与状态（低优先级、静默）。
 */
object Notifier {
    const val CH_APPROVAL = "approval"
    const val CH_STATUS = "status"
    private var nextId = 1000

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CH_APPROVAL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CH_APPROVAL, "需要审批", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "dsh 在等你批准一个动作"
                },
            )
        }
        if (manager.getNotificationChannel(CH_STATUS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CH_STATUS, "任务状态", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "会话跑完、连接断开等"
                },
            )
        }
    }

    private fun intent(context: Context): PendingIntent? {
        val launch = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun post(context: Context, title: String, body: String, channel: String = CH_STATUS) {
        ensureChannels(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, channel)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        val notification = builder
            .setContentTitle(title.take(80))
            .setContentText(body.take(200))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setContentIntent(intent(context))
            .build()
        try {
            manager.notify(nextId++, notification)
        } catch (_: SecurityException) {
            // Android 13+ 没给通知权限：静默，别崩
        }
    }
}