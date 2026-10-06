package com.bookkaro.assistant.core

/**
 * P40 — the ONE predefined script the IRCTC WebView receives (document start, IRCTC origin only):
 * assets/irctc-android-adapter.js (a `chrome.runtime` shim over the native message channel) wrapping the desktop
 * extension's own, unmodified irctc-handoff-guard.js + irctc-core.js + irctc-content.js (synced into the APK assets at
 * build time from ../extension — one implementation of the IRCTC page rules for desktop and Android).
 * Never built from server / page input; no "execute arbitrary JavaScript" path exists.
 */
object InjectedScript {
    const val ADAPTER = "irctc-android-adapter.js"
    val SHARED = listOf("bookkaro-irctc/irctc-handoff-guard.js", "bookkaro-irctc/irctc-core.js", "bookkaro-irctc/irctc-content.js")
    private val PLACEHOLDERS = listOf("/*__BOOKKARO_GUARD__*/", "/*__BOOKKARO_CORE__*/", "/*__BOOKKARO_CONTENT__*/")
    private const val VERSION = "__BOOKKARO_ANDROID_VERSION__"

    fun build(read: (String) -> String, version: String): String {
        var out = read(ADAPTER)
        require(PLACEHOLDERS.all { out.contains(it) } && out.contains(VERSION)) { "adapter template incomplete" }
        require(Regex("^[0-9A-Za-z.\\-]{1,32}$").matches(version)) { "bad version" }
        PLACEHOLDERS.zip(SHARED).forEach { (ph, file) -> out = out.replace(ph, read(file)) }
        return out.replace(VERSION, version)
    }
}
