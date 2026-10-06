package com.bookkaro.assistant.core

import java.net.URI
import java.util.Locale

/**
 * P40 — where a navigation may go.
 *  BookKaro WebView: the BookKaro origin stays inside; any other https link → external browser; anything else → blocked.
 *  IRCTC WebView: the IRCTC host stays inside (autofill still only on /nget/…); after the IRCTC PAYMENT / OTP step a
 *  bank / payment-gateway https page may load inside (no script, no bridge there); other https → external browser;
 *  non-https (intent:, file:, data:, javascript:, http:) → blocked.
 */
object NavigationPolicy {
    enum class Decision { LOAD_IN_WEBVIEW, OPEN_EXTERNAL, BLOCK }

    private fun scheme(url: String): String? = try { URI(url).scheme?.lowercase(Locale.ROOT) } catch (e: Exception) { null }

    fun forBookKaro(url: String, bookkaroOrigin: String): Decision {
        val origin = IrctcUrlPolicy.originOf(url)
        if (origin != null && origin == bookkaroOrigin.lowercase(Locale.ROOT).trimEnd('/')) return Decision.LOAD_IN_WEBVIEW
        return if (scheme(url) == "https") Decision.OPEN_EXTERNAL else Decision.BLOCK
    }

    fun forIrctc(url: String, lastIrctcPage: String?, allowMock: Boolean): Decision = when {
        IrctcUrlPolicy.isIrctcHost(url, allowMock) -> Decision.LOAD_IN_WEBVIEW
        scheme(url) != "https" -> Decision.BLOCK
        lastIrctcPage == "PAYMENT" || lastIrctcPage == "OTP" -> Decision.LOAD_IN_WEBVIEW
        else -> Decision.OPEN_EXTERNAL
    }
}
