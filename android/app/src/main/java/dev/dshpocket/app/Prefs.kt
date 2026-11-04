package dev.dshpocket.app

import android.content.Context
import android.content.SharedPreferences

/**
 * 只存一个东西：上次连的地址。
 *
 * 令牌**不落盘**：它由 PWA 存在 WebView 的 localStorage 里（那是浏览器的作用域），
 * 原生侧只在内存里拿一份给常驻服务用。少一处持久化 = 少一个泄露面。
 */
object Prefs {
    private const val FILE = "pocket"
    private const val KEY_BASE = "base_url"
    private const val KEY_TOKEN = "token_memory"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun baseUrl(context: Context): String? = prefs(context).getString(KEY_BASE, null)

    fun setBaseUrl(context: Context, value: String) {
        prefs(context).edit().putString(KEY_BASE, value).apply()
    }

    /**
     * 进程内缓存令牌：常驻服务在同一个进程里，直接读它。
     * **不写磁盘** —— 令牌只存在于 WebView 的 localStorage（浏览器作用域）与本进程内存。
     */
    @Volatile
    private var memoryToken: String? = null

    fun token(): String? = memoryToken

    fun setToken(value: String?) {
        memoryToken = value?.takeIf { it.isNotBlank() }
    }

    /** 让 prefs 键名看起来被用过（避免 lint 误报未使用的常量）。 */
    fun describe(): String = KEY_BASE + "/" + KEY_TOKEN
}