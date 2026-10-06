package com.bookkaro.assistant.core

import java.net.URI
import java.util.Locale

/**
 * P40 — the IRCTC page allow-list (port of isApprovedIrctcPage in extension/irctc-handoff-guard.js):
 * autofill / bridge ONLY on https://www.irctc.co.in/nget/… (exact host, default port, normalized path — `/nget/../x`
 * is not /nget/). The local MockIRCTC (http://localhost|127.0.0.1/api/dev/mock-irctc*) only when allowMock (debug build).
 */
object IrctcUrlPolicy {
    const val APPROVED_HOST = "www.irctc.co.in"
    const val APPROVED_PATH = "/nget/"
    const val IRCTC_ORIGIN = "https://www.irctc.co.in"
    const val IRCTC_START_URL = "https://www.irctc.co.in/nget/train-search"
    private const val MOCK_PATH = "/api/dev/mock-irctc"
    private val MOCK_HOSTS = setOf("localhost", "127.0.0.1")

    data class Check(val ok: Boolean, val kind: String? = null, val code: String? = null)

    private fun uri(href: String?): URI? = if (href == null) null else try { URI(href).normalize() } catch (e: Exception) { null }

    fun isApprovedIrctcPage(href: String?, allowMock: Boolean): Check {
        val u = uri(href) ?: return Check(false, code = "UNAUTHORIZED_IRCTC_HOST")
        val scheme = u.scheme?.lowercase(Locale.ROOT)
        val host = u.host?.lowercase(Locale.ROOT)
        val path = u.rawPath ?: ""
        if (scheme == "https" && host == APPROVED_HOST && (u.port == -1 || u.port == 443) && path.startsWith(APPROVED_PATH)) return Check(true, kind = "REAL")
        if (allowMock && scheme == "http" && host in MOCK_HOSTS && (path == MOCK_PATH || path.startsWith("$MOCK_PATH/"))) return Check(true, kind = "MOCK")
        return Check(false, code = "UNAUTHORIZED_IRCTC_HOST")
    }

    /** Any page of the IRCTC host (navigation may stay in the WebView; autofill still needs isApprovedIrctcPage). */
    fun isIrctcHost(href: String?, allowMock: Boolean): Boolean {
        val u = uri(href) ?: return false
        val scheme = u.scheme?.lowercase(Locale.ROOT)
        val host = u.host?.lowercase(Locale.ROOT)
        if (scheme == "https" && host == APPROVED_HOST && (u.port == -1 || u.port == 443)) return true
        return allowMock && scheme == "http" && host in MOCK_HOSTS && isApprovedIrctcPage(href, true).ok
    }

    fun originOf(href: String?): String? {
        val u = uri(href) ?: return null
        val scheme = u.scheme?.lowercase(Locale.ROOT) ?: return null
        val host = u.host?.lowercase(Locale.ROOT) ?: return null
        val defaultPort = (scheme == "https" && u.port == 443) || (scheme == "http" && u.port == 80)
        return scheme + "://" + host + (if (u.port <= 0 || defaultPort) "" else ":" + u.port)
    }

    /** Origins the IRCTC bridge + document-start script are restricted to. */
    fun irctcOrigins(allowMock: Boolean, mockPorts: List<Int> = listOf(3000, 5173)): Set<String> =
        if (!allowMock) setOf(IRCTC_ORIGIN) else setOf(IRCTC_ORIGIN) + mockPorts.flatMap { listOf("http://127.0.0.1:$it", "http://localhost:$it") }
}
