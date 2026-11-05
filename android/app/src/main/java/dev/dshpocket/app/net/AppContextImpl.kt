package dev.dshpocket.app.net

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import libtailscale.AppContext

/**
 * `libtailscale.AppContext` 的实现 —— 这个类就是 Go 引擎看 Android 的那扇窗。
 *
 * 接口是 gomobile 从 Go 侧生成的（22 个方法），少实现一个都编译不过；
 * 但绝大多数方法对「连我自己家的电脑」这件事没有意义，所以这里的原则是：
 *   · **必须真实现的**：设备名、登录态存取（`encryptToPref`/`decryptFromPref`）、
 *     把 socket 绑到当前网络（`bindSocketToNetwork`）、日志、SDK 版本；
 *   · **可以给安全默认值的**：syspolicy（返回 false/空）、硬件证明（不支持）、
 *     系统 CA（不注入）、安装来源。
 *
 * 登录态用 Android Keystore 里的 AES-GCM 加密后放私有 SharedPreferences，
 * 不是明文 —— 这份数据里含 tailnet 的节点密钥。
 */
class AppContextImpl(private val context: Context) : AppContext {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("tailnet_state", Context.MODE_PRIVATE)

    private val key: SecretKey by lazy {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey ?: run {
            val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
            generator.init(
                android.security.keystore.KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or
                        android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generator.generateKey()
        }
    }

    // ── 必须真实现的 ────────────────────────────────────────────────

    override fun getDeviceName(): String = Build.MODEL ?: "android"

    override fun encryptToPref(key: String, value: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, this.key)
            val payload = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
            prefs.edit().putString(key, payload).apply()
        } catch (err: Throwable) {
            Log.w(TAG, "encryptToPref 失败：" + err.message)
        }
    }

    override fun decryptFromPref(key: String): String {
        val payload = prefs.getString(key, null) ?: return ""
        return try {
            val parts = payload.split(":")
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val body = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, this.key, GCMParameterSpec(128, iv))
            String(cipher.doFinal(body))
        } catch (err: Throwable) {
            Log.w(TAG, "decryptFromPref 失败（当作没有登录态）：" + err.message)
            ""
        }
    }

    override fun bindSocketToNetwork(fd: Int): Boolean {
        return try {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val network: Network = manager.activeNetwork ?: return false
            // adoptFd 会接管这个 fd 的生命周期，不能直接拿 FileDescriptor 裸包（会把 Go 侧的 fd 关掉）
            val pfd = android.os.ParcelFileDescriptor.adoptFd(fd)
            try {
                network.bindSocket(pfd.fileDescriptor)
                true
            } finally {
                // 交还所有权：detach 后由 Go 侧继续持有这个 fd
                pfd.detachFd()
            }
        } catch (err: Throwable) {
            Log.w(TAG, "bindSocketToNetwork 失败：" + err.message)
            false
        }
    }

    override fun getSDKInt(): Long = Build.VERSION.SDK_INT.toLong()

    override fun getOSVersion(): String = Build.VERSION.RELEASE ?: ""

    override fun isClientLoggingEnabled(): Boolean = true

    override fun isChromeOS(): Boolean = false

    override fun log(level: String, message: String) {
        val tag = "Tailscale/$level"
        if (level == "error" || level == "warning") Log.w(tag, message) else Log.i(tag, message)
    }

    // ── 给安全默认值的 ──────────────────────────────────────────────

    override fun getInstallSource(): String = "dsh-pocket"

    override fun getInterfacesAsJson(): String = "{}"

    override fun getPlatformDNSConfig(): String = ""

    override fun getStateStoreKeysJSON(): String = ""

    override fun getSyspolicyBooleanValue(key: String): Boolean = false

    override fun getSyspolicyStringValue(key: String): String = ""

    override fun getSyspolicyStringArrayJSONValue(key: String): String = "[]"

    override fun getUserCACertsPEM(): ByteArray? = null

    override fun shouldUseGoogleDNSFallback(): Boolean = true

    // 硬件证明：Android 上有 API 可用，但接它要额外的证书链处理；不接也不影响登录与连接。
    override fun hardwareAttestationKeySupported(): Boolean = false

    override fun hardwareAttestationKeyCreate(): String = ""

    override fun hardwareAttestationKeyLoad(handle: String) = Unit

    override fun hardwareAttestationKeyPublic(handle: String): ByteArray? = null

    override fun hardwareAttestationKeyRelease(handle: String) = Unit

    override fun hardwareAttestationKeySign(handle: String, data: ByteArray): ByteArray? = null

    private companion object {
        const val TAG = "DshPocket"
        const val KEY_ALIAS = "dsh_pocket_tailnet"
    }
}