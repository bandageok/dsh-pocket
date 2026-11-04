// 仓库：默认是 google + mavenCentral；国内网络下 mavenCentral（repo1.maven.org）常常直连不上，
// 所以中间加了一个公共镜像。不在国内就把 MIRROR 一行删掉，行为与官方模板一致。
pluginManagement {
    repositories {
        google()
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") } // MIRROR
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") } // MIRROR
        mavenCentral()
    }
}

rootProject.name = "dsh-pocket"
include(":app")