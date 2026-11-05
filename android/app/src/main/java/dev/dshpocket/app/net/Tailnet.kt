package dev.dshpocket.app.net

import android.content.Context
import android.util.Log
import libtailscale.Application
import libtailscale.Libtailscale
import libtailscale.LocalAPIResponse
import libtailscale.NotificationCallback
import libtailscale.NotificationManager
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * 进程内 Tailscale 引擎：启动、登录、状态、找电脑。
 *
 * 结构照搬参考实现（DSHgo 的 `Tunnel.java`），保留它踩出来的三条判断：
 *
 * 1. **一切走 localapi**（`/localapi/v0/...`）：登录、WantRunning、status、peer 列表
 *    都是 Tailscale 自己的 HTTP 接口，比自己抓状态可靠。
 * 2. **status 必须缓存**：弱网下一次 status 能卡好几秒，界面线程不能被它拖住。
 * 3. **`NoState` 不能当「未登录」**：冷启动时会闪一下 NoState，要它持续 8 秒以上才算数，
 *    否则会把「正在启动」误判成「去登录」。
 */
object Tailnet {

    private const val TAG = "DshPocket"
    private const val PREFIX = "/localapi/v0/"

    @Volatile private var app: Application? = null
    @Volatile private var watch: NotificationManager? = null
    @Volatile private var lastNotify = ""
    @Volatile private var browseUrl = ""

    @Volatile private var statusCache: JSONObject = JSONObject()
    @Volatile private var statusAt = 0L
    @Volatile private var statusBusy = false
    @Volatile private var statusEverOk = false
    @Volatile private var noStateSince = 0L

    /** 启动引擎（幂等）。dataDir 用 App 私有目录；第二个参数留给「直连文件根」，我们不用。 */
    @Synchronized
    fun ensureEngine(context: Context): Application? {
        app?.let { return it }
        return try {
            val started = Libtailscale.start(
                context.filesDir.absolutePath,
                "",
                false,
                AppContextImpl(context.applicationContext),
            )
            app = started
            watchNotifications()
            // 告诉后端前端到了；重复调用无害
            runCatching { call("POST", "start", "{\"FrontendLogID\":\"dsh-pocket\"}") }
            Log.i(TAG, "Tailscale 引擎已启动")
            started
        } catch (err: Throwable) {
            Log.w(TAG, "引擎启动失败：" + err.message)
            null
        }
    }

    private fun watchNotifications() {
        val engine = app ?: return
        if (watch != null) return
        watch = runCatching {
            engine.watchNotifications(0, object : NotificationCallback {
                override fun onNotify(json: ByteArray?) {
                    if (json == null) return
                    lastNotify = String(json, StandardCharsets.UTF_8)
                    if (lastNotify.contains("https://")) browseUrl = extractUrl(lastNotify)
                }
            })
        }.getOrNull()
    }

    private fun extractUrl(text: String): String {
        val at = text.indexOf("https://")
        if (at < 0) return ""
        var end = at
        while (end < text.length && "\"\\ \n\r\t".indexOf(text[end]) < 0) end += 1
        return text.substring(at, end)
    }

    private fun call(method: String, path: String, body: String?, timeoutMs: Long = 15000): String {
        val engine = app ?: throw IllegalStateException("engine not started")
        val input = body?.let { text ->
            object : libtailscale.InputStream {
                private var done = false
                override fun read(): ByteArray? {
                    if (done) return null
                    done = true
                    return text.toByteArray(StandardCharsets.UTF_8)
                }
                override fun close() = Unit
            }
        }
        val response: LocalAPIResponse = engine.callLocalAPI(timeoutMs, method, PREFIX + path, input)
        val bytes = response.bodyBytes()
        val text = if (bytes == null) "" else String(bytes, StandardCharsets.UTF_8)
        if (response.statusCode() >= 400) throw IllegalStateException("HTTP ${response.statusCode()}: $text")
        return text
    }

    // ── 状态 ────────────────────────────────────────────────────────

    fun status(): JSONObject {
        val now = System.currentTimeMillis()
        if (now - statusAt > 4000 && !statusBusy) {
            statusBusy = true
            Thread({
                runCatching { call("GET", "status", null, 6000) }
                    .onSuccess {
                        statusCache = runCatching { JSONObject(it) }.getOrDefault(JSONObject())
                        statusEverOk = true
                    }
                statusAt = System.currentTimeMillis()
                statusBusy = false
            }, "tailnet-status").start()
        }
        return statusCache
    }

    fun backendState(): String = status().optString("BackendState", "")

    fun isRunning(): Boolean = backendState() == "Running"

    fun isLoggedIn(): Boolean {
        val state = backendState()
        if (state == "Running" || state == "Starting") return true
        val self = status().optJSONObject("Self") ?: return false
        val user = self.optString("UserID", "")
        return user.isNotEmpty() && user != "0"
    }

    fun needsLogin(): Boolean {
        if (!statusEverOk) return false
        when (backendState()) {
            "NeedsLogin" -> return true
            "NoState" -> {
                val now = System.currentTimeMillis()
                if (noStateSince == 0L) noStateSince = now
                return now - noStateSince > 8000
            }
        }
        noStateSince = 0
        return false
    }

    /** 让后端进入「想连」状态；这一步之后隧道才会真的建立。 */
    fun setWantRunning(want: Boolean) {
        runCatching {
            call("PATCH", "prefs", "{\"WantRunningSet\":true,\"WantRunning\":$want,\"CorpDNSSet\":true,\"CorpDNS\":true}")
        }.onFailure { Log.w(TAG, "setWantRunning: " + it.message) }
    }

    /** 交互式登录：返回必须让用户在浏览器/WebView 里打开的授权地址。 */
    fun startLogin(): String {
        browseUrl = ""
        runCatching {
            val text = call("POST", "login-interactive", "")
            browseUrl = extractUrl(text)
        }.onFailure { Log.w(TAG, "login-interactive: " + it.message) }
        if (browseUrl.isEmpty()) browseUrl = status().optString("AuthURL", "")
        return browseUrl
    }

    fun logout() {
        runCatching { call("POST", "logout", "") }
    }

    fun lastNotification(): String = lastNotify

    // ── 在 tailnet 里找那台电脑 ──────────────────────────────────────

    /**
     * 从 status 里列出 tailnet 对端的 100.x 地址。
     * 只取在线、且不是自己的那些 —— 剩下的交给探测（谁开着 dsh-pocket 的端口就是谁）。
     */
    fun peerAddresses(): List<String> {
        val out = ArrayList<String>()
        val peers = runCatching { status().optJSONObject("Peer") }.getOrNull() ?: return out
        val keys = peers.keys()
        while (keys.hasNext()) {
            val peer = peers.optJSONObject(keys.next()) ?: continue
            val online = peer.optBoolean("Online", false)
            if (!online) continue
            val ips = peer.optJSONArray("TailscaleIPs") ?: continue
            for (i in 0 until ips.length()) {
                val ip = ips.optString(i, "")
                if (ip.startsWith("100.")) out.add(ip)
            }
        }
        return out
    }
}