package dev.dshpocket.app

import android.content.Context
import android.util.Log

/**
 * 崩溃/异常留痕。
 *
 * 为什么需要它：手机上「点一下就闪退」时，用户能提供的信息只有一个「闪退」。
 * 而真正的异常在 logcat 里，用户不会捞。所以这里做两件事：
 *
 *   · 把异常类型 + 消息 + 前几层栈写进私有 SharedPreferences（覆盖式，只留最近一条）；
 *   · 下次打开 App 时把这条直接显示在状态栏，用户截图就能给我定位。
 *
 * 同时注册全局未捕获异常处理 —— 那些没被 try 住、直接把进程带走的错误也能留下痕迹。
 * 注意：**不能吞掉**异常，处理器最后要把控制权交回系统默认行为，否则会变成「卡死」。
 */
object CrashLog {

    private const val TAG = "DshPocket"
    private const val PREFS = "crash"
    private const val KEY = "last"

    fun record(context: Context, where: String, err: Throwable) {
        val text = buildString {
            append(where).append("：")
            append(err.javaClass.simpleName)
            if (!err.message.isNullOrBlank()) append(" - ").append(err.message)
            append('\n')
            err.stackTrace.take(4).forEach { append("  at ").append(it).append('\n') }
        }
        runCatching {
            context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY, text)
                .apply()
        }
        Log.w(TAG, text)
    }

    /** 取走最近一条（取完即清，避免每次启动都弹）。 */
    fun take(context: Context): String? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val text = prefs.getString(KEY, null) ?: return null
        prefs.edit().remove(KEY).apply()
        return text
    }

    /** 全局兜底：没被 try 住的异常也留一条痕迹，然后把控制权交回系统。 */
    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            record(app, "未捕获（" + thread.name + "）", err)
            previous?.uncaughtException(thread, err)
        }
    }
}