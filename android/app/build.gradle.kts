// P40 — BookKaro Android app (debug APK only; not for the Play Store).
import java.net.URI
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// BookKaro web app the shell opens (HTTPS production by default; -Pbookkaro.url=… for another BookKaro server)
val bookkaroUrl: String = (project.findProperty("bookkaro.url") as String?) ?: "https://bookkaro-ai-assistant.onrender.com/"
val bookkaroOrigin: String = URI(bookkaroUrl).let { u: URI -> u.scheme + "://" + u.host + (if (u.port > 0) ":" + u.port else "") }
// the desktop extension's own page scripts — reused unmodified, copied into the APK at build time
val extensionDir = rootProject.file("../extension")
val generatedAssets = layout.buildDirectory.dir("generated/bookkaro-assets")

android {
    namespace = "com.bookkaro.assistant"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bookkaro.assistant"
        minSdk = 26
        targetSdk = 34
        versionCode = 41
        versionName = "0.40.1"
        buildConfigField("String", "BOOKKARO_URL", "\"$bookkaroUrl\"")
        buildConfigField("String", "BOOKKARO_ORIGIN", "\"$bookkaroOrigin\"")
    }

    buildTypes {
        getByName("debug") {
            // the local MockIRCTC (localhost / 127.0.0.1) is allowed ONLY in debug builds
            buildConfigField("boolean", "ALLOW_MOCK_IRCTC", "true")
        }
        getByName("release") {
            isMinifyEnabled = false
            buildConfigField("boolean", "ALLOW_MOCK_IRCTC", "false")
        }
    }

    buildFeatures { buildConfig = true }

    sourceSets {
        getByName("main") { assets.srcDir(generatedAssets) }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    testOptions {
        unitTests.all {
            it.systemProperty("bookkaro.extensionDir", extensionDir.absolutePath)
            it.systemProperty("bookkaro.assetsDir", file("src/main/assets").absolutePath)
            it.maxHeapSize = "384m"
        }
    }
}

val syncIrctcScripts by tasks.registering(Copy::class) {
    description = "Copies the unmodified extension IRCTC page scripts into the APK assets (bookkaro-irctc/)."
    from(extensionDir) { include("irctc-handoff-guard.js", "irctc-core.js", "irctc-content.js") }
    into(generatedAssets.map { it.dir("bookkaro-irctc") })
    doLast {
        listOf("irctc-handoff-guard.js", "irctc-core.js", "irctc-content.js").forEach { name ->
            check(File(extensionDir, name).isFile) { "missing extension/$name" }
        }
    }
}
tasks.named("preBuild") { dependsOn(syncIrctcScripts) }

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.11.0")
    testImplementation("junit:junit:4.13.2")
}
