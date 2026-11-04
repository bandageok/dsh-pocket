package dev.dshpocket.app

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * WebView ↔ 原生的桥。
 *
 * 只暴露四个方法，全部无参或只收字符串 —— JS 桥是权限边界，宁可窄：
 *
 *   token(t)         PWA 把配对令牌交过来（内存里存一份，给常驻服务用）
 *   watch(base)      起常驻事件流服务（审批与「跑完了」的通知）
 *   notify(title,body) PWA 主动发一条系统通知
 *   tailnet()        问当前隧道处于哪一档（embedded / system / lan）
 *
 * 注意：这里**不做**文件读写、不读剪贴板、不提供任意 URL 请求（否则等于给网页开 shell）。
 */
class PocketBridge(private val activity: MainActivity, private val web: WebView) {

    @JavascriptInterface
    fun token(value: String) {
        Prefs.setToken(value)
    }

    @JavascriptInterface
    fun watch(base: String) {
        startWatch(base)
    }

    @JavascriptInterface
    fun notify(title: String, body: String) {
        Notifier.post(activity, title, body)
    }

    @JavascriptInterface
    fun tailnet(): String = TailnetController.describe(activity)

    /** 从页面里把 PWA 存的令牌捞出来（PWA 把配置放在 localStorage 的 dshpocket.* 下）。 */
    fun adoptFromPage(view: WebView) {
        view.evaluateJavascript(
            "(function(){try{" +
                "var t=localStorage.getItem('dshpocket.token')||'';" +
                "var b=localStorage.getItem('dshpocket.base')||'';" +
                "if(window.PocketNative){if(t)window.PocketNative.token(t);if(b)window.PocketNative.watch(b);}" +
                "return t?'1':'0';}catch(e){return '0';}})()",
        ) { result ->
            if (result?.contains("1") == true) {
                // 令牌拿到了，常驻服务可以开始收事件
                startWatch(Prefs.baseUrl(activity) ?: return@evaluateJavascript)
            }
        }
    }

    fun startWatch(base: String) {
        if (Prefs.token() == null) return // 还没配对，起了也连不上
        val intent = Intent(activity, WatchService::class.java).putExtra("base", base)
        try {
            activity.startForegroundService(intent)
        } catch (_: Exception) {
            // Android 12+ 后台启动前台的限制：失败就等用户下次回到界面
        }
    }
}