// 原生壳的 Gradle 配置（Kotlin DSL）。
//
// 设计目标：**没有 libtailscale.aar 也能编、能跑**（退化成局域网 / 系统 Tailscale 模式）。
// 所以 AAR 是「存在才加进 classpath」，Kotlin 侧一律走反射调用（TailnetController），
// 绝不 import libtailscale 的类 —— 否则缺 AAR 时连编译都过不去。
plugins {
    id("com.android.application") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "dev.dshpocket.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.dshpocket.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 内置 Tailscale 需要 gomobile 产出的 AAR；没有就不加，工程照样能编。
    // 产出方法见 android/README.md。
    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")

    val tailscaleAar = file("libs/libtailscale.aar")
    if (tailscaleAar.exists()) {
        implementation(files(tailscaleAar))
    }
}