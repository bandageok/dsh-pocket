package dev.dshpocket.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import dev.dshpocket.app.net.Tailnet
import dev.dshpocket.app.net.TailnetService

/**
 * 原生壳的主界面。
 *
 * 取舍：**UI 仍然是插件服务的那套 PWA**，原生只负责三件事：
 *   1. 把 WebView 指到正确的地址（局域网 / tailnet / 中继）
 *   2. 申请内置 Tailscale 隧道（见 TailnetController，三档降级）
 *   3. 起常驻服务收通知（审批 / 跑完了）—— 这是 PWA 在手机上做不到的
 *
 * 为什么不重写界面：PWA 已经把转录、上传、审批、诊断全做了；重写一遍既慢，
 * 又会立刻和插件的协议漂移。原生壳的价值在系统集成，不在画界面。
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        /** 插件的默认端口；用户只填 IP 时补它，否则会去连 80 端口。 */
        const val DEFAULT_PORT = 3081
        const val VPN_REQUEST = 9001
    }

    private lateinit var web: WebView
    private lateinit var urlField: EditText
    private lateinit var status: TextView
    private lateinit var bridge: PocketBridge
    private val io = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        urlField = findViewById(R.id.url)
        status = findViewById(R.id.status)

        val saved = Prefs.baseUrl(this)
        urlField.setText(saved ?: "http://")
        status.text = "模式：" + TailnetController.describe(this)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // PWA 用 localStorage 存令牌与缓存，必须开
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 只在自己这个来源里导航；外部链接交给系统浏览器
                val url = request.url
                val base = Prefs.baseUrl(this@MainActivity)
                if (base != null && url.toString().startsWith(base.trimEnd('/'))) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                } catch (_: Exception) {
                    false
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // 主文档失败才提示；子资源失败（图标之类）不打扰用户
                if (!request.isForMainFrame) return
                val host = Uri.parse(request.url.toString()).host ?: "地址"
                val why = error.description?.toString() ?: "网络错误"
                status.visibility = View.VISIBLE
                status.text = "连不上 " + host + "：" + why + "　（检查：是否同一网络 / 地址里的端口）"
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // PWA 把令牌放在 localStorage；桥只取用，不落盘
                bridge.adoptFromPage(view)
            }
        }

        bridge = PocketBridge(this, web)
        web.addJavascriptInterface(bridge, "PocketNative")

        findViewById<Button>(R.id.connect).setOnClickListener { connect(urlField.text.toString()) }
        findViewById<Button>(R.id.probe).setOnClickListener { probeNow() }
        findViewById<Button>(R.id.tunnel).setOnClickListener { toggleTunnel() }
        findViewById<Button>(R.id.login).setOnClickListener { openLogin() }
        findViewById<Button>(R.id.detect).setOnClickListener { detect() }

        // 已经配过就直接进
        if (!saved.isNullOrBlank()) connect(saved)
    }

    /**
     * 归一化用户输入的地址。
     *
     * 三个真实踩过的坑，全在这里兜住：
     *   1. 只填 IP（最常见）→ 必须补 **:3081**。不补就会去连 80 端口，
     *      WebView 只会显示「网页无法打开」——用户完全看不出是端口错了。
     *   2. https + 域名（cloudflared / 反代）→ **不能**补 3081，443 就是对的。
     *   3. 只填到根路径 → 补 `/__pocket__/` 挂载点。
     */
    private fun normalize(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        if (!text.startsWith("http://") && !text.startsWith("https://")) text = "http://$text"
        val uri = Uri.parse(text)
        val host = uri.host ?: return null
        val scheme = uri.scheme ?: "http"
        val looksLikeLiteral = host == "localhost" || host.matches(Regex("^[0-9.]+$")) || host.startsWith("[")
        val port = when {
            uri.port > 0 -> uri.port
            scheme == "https" -> -1            // 走默认 443，别乱加端口
            looksLikeLiteral -> DEFAULT_PORT   // 局域网/tailnet 的裸 IP
            else -> -1
        }
        val tail = uri.encodedPath?.takeIf { it.contains("__pocket__") } ?: "/__pocket__/"
        val withSlash = if (tail.endsWith("/")) tail else "$tail/"
        return buildString {
            append(scheme).append("://").append(host)
            if (port > 0) append(":").append(port)
            append(withSlash)
        }
    }

    private fun connect(raw: String) {
        val target = normalize(raw) ?: run {
            Toast.makeText(this, "地址不对", Toast.LENGTH_SHORT).show()
            return
        }
        Prefs.setBaseUrl(this, target)
        urlField.setText(target)
        status.text = "连接 " + Uri.parse(target).host + " …"
        web.loadUrl(target)
        bridge.startWatch(target)
    }

    // ── 内置 Tailscale ────────────────────────────────────────────────

    private val main = Handler(Looper.getMainLooper())

    /**
     * 一键隧道：引擎 → VPN 授权 → 后台建连 → 在 tailnet 里找电脑 → 打开它。
     *
     * 这条路和参考实现一致：引擎跑在本进程里，VpnService 只承载本 App 的流量，
     * 所以「不在同一局域网」靠的是 WireGuard 打洞/DERP 中继，而不是端口映射。
     */
    private fun toggleTunnel() {
        if (Tailnet.isRunning()) {
            Tailnet.setWantRunning(false)
            TailnetService.stop(this)
            status.visibility = View.VISIBLE
            status.text = "隧道已停止（回到局域网模式）"
            return
        }
        Tailnet.unsupportedAbi()?.let { abis ->
            status.visibility = View.VISIBLE
            status.text = "这台设备的 CPU 架构（$abis）不在内置引擎的打包范围内，用局域网/中继模式"
            return
        }
        if (Tailnet.ensureEngine(this) == null) {
            status.visibility = View.VISIBLE
            status.text = "引擎启动失败：看 adb logcat -s DshPocket"
            return
        }
        val consent = VpnService.prepare(this)
        if (consent != null) {
            startActivityForResult(consent, VPN_REQUEST)
            return
        }
        startTunnel()
    }

    private fun startTunnel() {
        TailnetService.start(this)
        Tailnet.setWantRunning(true)
        status.visibility = View.VISIBLE
        status.text = "隧道启动中…"
        pollTunnel(0)
    }

    private fun pollTunnel(tries: Int) {
        io.execute {
            val state = Tailnet.backendState()
            val needLogin = Tailnet.needsLogin()
            runOnUiThread {
                status.visibility = View.VISIBLE
                status.text = "隧道：" + (if (state.isEmpty()) "启动中" else state)
                when {
                    state == "Running" -> discoverAndLoad()
                    needLogin && tries > 2 -> openLogin()
                    tries < 25 -> main.postDelayed({ pollTunnel(tries + 1) }, 1200)
                    else -> status.text = "隧道没能起来（" + (if (state.isEmpty()) "无响应" else state) + "）"
                }
            }
        }
    }

    /** 交互式登录：把授权页放到 WebView 里，登录完系统会回到 App。 */
    private fun openLogin() {
        io.execute {
            status.post { status.visibility = View.VISIBLE; status.text = "正在取登录地址…" }
            val url = Tailnet.awaitAuthUrl()
            runOnUiThread {
                if (url.isEmpty()) {
                    status.visibility = View.VISIBLE
                    status.text = "拿不到登录地址：先点「启动隧道」，或看 logcat"
                } else {
                    status.visibility = View.VISIBLE
                    status.text = "在下面登录 Tailscale，完成后回到这里点「连接」"
                    web.loadUrl(url)
                }
            }
        }
    }

    /**
     * tailnet 里找那台电脑：逐个探对端的 3081 端口，谁回 health 就是它。
     * 只探在线 peer，且限 100.x，避免把手机自己的出口也扫一遍。
     */
    private fun discoverAndLoad() {
        val peers = Tailnet.peerAddresses()
        status.text = "隧道已连，正在找电脑…（" + peers.size + " 个在线节点）"
        io.execute {
            for (ip in peers) {
                val base = "http://" + ip + ":" + DEFAULT_PORT + "/__pocket__/"
                if (probe(base)) {
                    runOnUiThread { connect(base) }
                    return@execute
                }
            }
            runOnUiThread {
                status.visibility = View.VISIBLE
                status.text = "隧道通了，但没找到开着 dsh-pocket 的电脑（检查电脑端 Tailscale 是否登录）"
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST) {
            if (resultCode == RESULT_OK) startTunnel()
            else {
                status.visibility = View.VISIBLE
                status.text = "没给 VPN 权限，内置隧道用不了（可以继续用局域网 / 中继）"
            }
        }
    }

    /**
     * 「测试」：不做连接，只回答「现在到底卡在哪」。
     *
     * 之所以要它：WebView 只会说「网页无法打开」，而我们的失败有五种完全不同的原因
     * （没在跑 / 端口错 / 不同网段 / 防火墙 / Tailscale 没连），必须一次说清。
     */
    private fun probeNow() {
        val base = normalize(urlField.text.toString()) ?: run {
            status.text = "地址不合法"; return
        }
        status.text = "测试 " + Uri.parse(base).host + " …"
        io.execute {
            val startedAt = System.currentTimeMillis()
            val result = try {
                val conn = URL(base.trimEnd('/') + "/health").openConnection() as HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                "HTTP $code " + body.take(80)
            } catch (err: Throwable) {
                val kind = when {
                    err is java.net.SocketTimeoutException -> "超时（手机连不到这台电脑：不同网段 / 防火墙 / 隧道没开）"
                    err is java.net.ConnectException -> "拒绝连接（端口没开：插件没跑？端口不是 3081？）"
                    err is java.net.UnknownHostException -> "域名解析失败（地址写错了？）"
                    else -> (err.message ?: err.javaClass.simpleName)
                }
                "失败：" + kind
            }
            val ms = System.currentTimeMillis() - startedAt
            runOnUiThread {
                status.visibility = View.VISIBLE
                status.text = result + "　(" + ms + " ms)　模式：" + TailnetController.describe(this)
            }
        }
    }

    /**
     * 自动探测：插件在 /health 里返回所有可达地址（含 tailnet 的 100.x）。
     * 这里并发赛跑，选第一个回话的 —— 和 PWA 的「自动探测」同一套逻辑。
     */
    private fun detect() {
        val base = normalize(urlField.text.toString()) ?: return
        status.text = "探测中…"
        io.execute {
            val current = Uri.parse(base)
            val candidates = mutableListOf(base)
            val health = httpGet(base.trimEnd('/') + "/__pocket__/health")
            if (health != null) {
                try {
                    val json = JSONObject(health)
                    val addresses = json.optJSONArray("addresses")
                    val port = if (current.port > 0) current.port else 3081
                    for (i in 0 until (addresses?.length() ?: 0)) {
                        val host = addresses?.optString(i) ?: continue
                        candidates.add("${current.scheme}://$host:$port/__pocket__/")
                    }
                } catch (_: Exception) {
                    // 老服务端没有 addresses：只用当前地址
                }
            }
            val hit = candidates.distinct().firstOrNull { probe(it) } ?: base
            runOnUiThread {
                status.text = "已选 " + Uri.parse(hit).host
                connect(hit)
            }
        }
    }

    private fun httpGet(url: String): String? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 3000
        conn.requestMethod = "GET"
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        body
    } catch (_: Exception) {
        null
    }

    private fun probe(base: String): Boolean = httpGet(base.trimEnd('/') + "/health")?.contains("\"ok\":true") == true

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        // 后台时让常驻服务继续收事件；WebView 暂停以省电
        if (::web.isInitialized) web.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) {
            web.onResume()
            status.visibility = if (web.url == null) View.VISIBLE else View.GONE
        }
    }
}