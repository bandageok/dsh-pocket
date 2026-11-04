package dev.dshpocket.app

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 常驻事件流：连 `/__pocket__/api/stream`，把两件事变成系统通知。
 *
 *   1. `event: approval`  —— 有动作等你批准（高优先级）
 *   2. `event: state`     —— 某个会话从 running=true 变成 false（跑完了）
 *
 * 为什么不用 Flamebase/Push：那要外部服务与账号。这里是一条本地 SSE 长连接，
 * 断了自己退避重连 —— 和 PWA 用同一条协议，只是跑在系统服务里，冻结不了。
 */
class WatchService : Service() {

    private val running = AtomicBoolean(false)
    private var worker: Thread? = null
    @Volatile private var stopped = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        startForeground(FOREGROUND_ID, foregroundNotification("正在同步电脑上的会话"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val base = intent?.getStringExtra("base") ?: Prefs.baseUrl(this)
        val token = Prefs.token()
        if (base.isNullOrBlank() || token.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (running.compareAndSet(false, true)) {
            stopped = false
            worker = thread(name = "pocket-watch", isDaemon = true) { loop(base, token) }
        }
        return START_STICKY
    }

    private fun loop(base: String, token: String) {
        var backoff = 1000L
        while (!stopped) {
            try {
                stream(base, token)
                backoff = 1000L
            } catch (_: Exception) {
                // 连不上就退避重连；不弹通知，避免半夜吵人
            }
            if (stopped) break
            Thread.sleep(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000L)
        }
        running.set(false)
    }

    /** 一条 SSE 长连接。只关心 event/state、event/approval 两种帧。 */
    private fun stream(base: String, token: String) {
        val url = URL(base.trimEnd('/') + "/api/stream?pocket=" + java.net.URLEncoder.encode(token, "UTF-8"))
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 0 // 长连接
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            if (conn.responseCode != 200) return
            BufferedReader(InputStreamReader(conn.inputStream)).use { reader ->
                var event = ""
                var data = StringBuilder()
                while (!stopped) {
                    val line = reader.readLine() ?: break
                    when {
                        line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                        line.startsWith("data:") -> data.append(line.removePrefix("data:").trim())
                        line.isEmpty() -> {
                            if (event.isNotEmpty() && data.isNotEmpty()) handle(event, data.toString())
                            event = ""
                            data = StringBuilder()
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun handle(event: String, payload: String) {
        try {
            when (event) {
                "approval" -> {
                    val json = JSONObject(payload)
                    val tool = json.optString("tool", "ai")
                    val reason = json.optString("reason", "")
                    Notifier.post(this, "需要审批：$tool", reason.ifBlank { "打开 App 处理" }, Notifier.CH_APPROVAL)
                }
                "state" -> {
                    // 只报「跑完了」这一个状态跃迁，其余交给 App 里的界面
                    val sessions = JSONObject(payload).optJSONArray("sessions") ?: return
                    for (i in 0 until sessions.length()) {
                        val item = sessions.optJSONObject(i) ?: continue
                        val id = item.optString("short", "会话")
                        val nowRunning = item.optBoolean("running", false)
                        val was = lastRunning[item.optString("id")]
                        if (was == true && !nowRunning) {
                            Notifier.post(this, "跑完了：$id", "会话已空闲，可以看结果了", Notifier.CH_STATUS)
                        }
                        lastRunning[item.optString("id")] = nowRunning
                    }
                }
            }
        } catch (_: Exception) {
            // 帧格式不认识就丢掉 —— 通知层不该因为一条脏数据崩掉
        }
    }

    private val lastRunning = HashMap<String, Boolean>()

    private fun foregroundNotification(text: String): Notification {
        Notifier.ensureChannels(this)
        val builder = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            Notification.Builder(this, Notifier.CH_STATUS)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("dsh-pocket")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopped = true
        worker?.interrupt()
        super.onDestroy()
    }

    companion object {
        private const val FOREGROUND_ID = 42

        fun stop(context: Context) {
            context.stopService(Intent(context, WatchService::class.java))
        }
    }
}