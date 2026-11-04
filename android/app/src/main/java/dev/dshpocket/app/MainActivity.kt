package dev.dshpocket.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
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

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // PWA 把令牌放在 localStorage；桥只取用，不落盘
                bridge.adoptFromPage(view)
            }
        }

        bridge = PocketBridge(this, web)
        web.addJavascriptInterface(bridge, "PocketNative")

        findViewById<Button>(R.id.connect).setOnClickListener { connect(urlField.text.toString()) }
        findViewById<Button>(R.id.detect).setOnClickListener { detect() }

        // 已经配过就直接进
        if (!saved.isNullOrBlank()) connect(saved)
    }

    /** 归一化用户输入的地址：允许只填 IP，自动补 scheme 与 __pocket__/ 挂载点。 */
    private fun normalize(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        if (!text.startsWith("http://") && !text.startsWith("https://")) text = "http://$text"
        val withMount = if (text.contains("/__pocket__")) text else text.trimEnd('/') + "/__pocket__/"
        return try {
            URL(withMount).toString()
        } catch (_: Exception) {
            null
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