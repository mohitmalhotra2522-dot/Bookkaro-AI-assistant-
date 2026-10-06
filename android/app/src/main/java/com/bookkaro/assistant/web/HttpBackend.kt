package com.bookkaro.assistant.web

import com.bookkaro.assistant.core.HandoffController
import com.bookkaro.assistant.core.Json
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * P40 — the only two backend calls the native side makes, both to the fixed BookKaro origin (BuildConfig), both the
 * existing P39.3 endpoints the desktop extension uses: GET /api/irctc/handoff/:id and POST /api/irctc/handoff/:id/events,
 * authorised by the bridge token header. No redirects followed, no caching, nothing logged.
 */
class HttpBackend(private val origin: String) : HandoffController.Backend {
    private val tokenHeader = "X-BookKaro-Bridge-Token"

    private fun call(method: String, path: String, token: String, body: String?): HandoffController.HttpResult {
        val c = URL(origin.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 20_000
            c.useCaches = false
            c.instanceFollowRedirects = false
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("Cache-Control", "no-store")
            c.setRequestProperty(tokenHeader, token)
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            @Suppress("UNCHECKED_CAST")
            val parsed = try { Json.parse(text) as? Map<String, Any?> } catch (e: Exception) { null }
            return HandoffController.HttpResult(status, parsed)
        } finally {
            c.disconnect()
        }
    }

    private fun idPath(id: String) = "/api/irctc/handoff/" + URLEncoder.encode(id, "UTF-8")

    override fun getSnapshot(handoffId: String, bridgeToken: String) = call("GET", idPath(handoffId), bridgeToken, null)
    override fun postEvent(handoffId: String, bridgeToken: String, eventJson: String) = call("POST", idPath(handoffId) + "/events", bridgeToken, eventJson)
}
