package com.bookkaro.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.bookkaro.assistant.core.NavigationPolicy.Decision as D
import java.io.File

/** P40 G2 — navigation rules of both WebViews + the one injected script (adapter around the unmodified extension files). */
class NavigationAndScriptTest {
    private val origin = "https://bookkaro-ai-assistant.onrender.com"

    @Test fun bookkaroWebViewKeepsOnlyBookKaroInside() {
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forBookKaro("$origin/chat?x=1", origin))
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forBookKaro("https://BOOKKARO-ai-assistant.onrender.com:443/", "$origin/"))
        assertEquals(D.OPEN_EXTERNAL, NavigationPolicy.forBookKaro("https://www.irctc.co.in/nget/train-search", origin))
        assertEquals(D.OPEN_EXTERNAL, NavigationPolicy.forBookKaro("https://bookkaro-ai-assistant.onrender.com.evil.example/", origin))
        for (u in listOf("http://bookkaro-ai-assistant.onrender.com/", "intent://x#Intent;end", "file:///sdcard/a.html", "javascript:alert(1)", "data:text/html,x"))
            assertEquals(u, D.BLOCK, NavigationPolicy.forBookKaro(u, origin))
    }

    @Test fun irctcWebViewStaysOnIrctcUntilThePaymentStep() {
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forIrctc("https://www.irctc.co.in/nget/train-list", null, false))
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forIrctc("https://www.irctc.co.in/eticketing/x", "LOGIN", false))   // IRCTC host: navigation ok, no autofill
        assertEquals(D.OPEN_EXTERNAL, NavigationPolicy.forIrctc("https://bank.example/pay", "TRAIN_LIST", false))
        assertEquals(D.OPEN_EXTERNAL, NavigationPolicy.forIrctc("https://bank.example/pay", null, false))
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forIrctc("https://bank.example/pay", "PAYMENT", false))          // gateway after the IRCTC payment page
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forIrctc("https://bank.example/otp", "OTP", false))
        for (u in listOf("http://www.irctc.co.in/nget/", "intent://x#Intent;end", "javascript:alert(1)", "upi://pay?pa=x"))
            assertEquals(u, D.BLOCK, NavigationPolicy.forIrctc(u, "PAYMENT", false))
        // debug: local MockIRCTC allowed; release: blocked
        assertEquals(D.LOAD_IN_WEBVIEW, NavigationPolicy.forIrctc("http://localhost:3000/api/dev/mock-irctc/real-search", null, true))
        assertEquals(D.BLOCK, NavigationPolicy.forIrctc("http://localhost:3000/api/dev/mock-irctc/real-search", null, false))
    }

    @Test fun injectedScriptIsTheAdapterAroundTheUnmodifiedExtensionFiles() {
        val ext = File(System.getProperty("bookkaro.extensionDir")!!)
        val assets = File(System.getProperty("bookkaro.assetsDir")!!)
        val read: (String) -> String = { name ->
            if (name.startsWith("bookkaro-irctc/")) File(ext, name.removePrefix("bookkaro-irctc/")).readText() else File(assets, name).readText()
        }
        val s = InjectedScript.build(read, "android-0.40.0")
        for (f in listOf("irctc-handoff-guard.js", "irctc-core.js", "irctc-content.js")) assertTrue(f, s.contains(File(ext, f).readText()))
        assertFalse(Regex("__BOOKKARO_(GUARD|CORE|CONTENT|ANDROID_VERSION)__").containsMatchIn(s))
        assertTrue(s.contains("return { version: 'android-0.40.0' }"))
        assertTrue(s.contains("window.BookKaroIrctc"))
        assertFalse(s.contains("addJavascriptInterface"))
        try { InjectedScript.build(read, "1\"; alert(1);//"); throw AssertionError("bad version accepted") } catch (e: IllegalArgumentException) { assertEquals("bad version", e.message) }
        try { InjectedScript.build({ n -> if (n == InjectedScript.ADAPTER) "no placeholders" else read(n) }, "1"); throw AssertionError("incomplete template accepted") } catch (e: IllegalArgumentException) { assertEquals("adapter template incomplete", e.message) }
    }
}
