package com.bookkaro.assistant.core

/**
 * P40 — the ONLY messages the two WebView bridges accept (everything else → Invalid, nothing executed):
 *  BookKaro page → native: {source:'bookkaro-app', type:'BK_PING'} | {source:'bookkaro-app', type:'BK_IRCTC_HANDOFF',
 *    handoffId, bridgeToken, reviewVersion} (the same three P39.3 binding values the desktop extension receives) |
 *    P40.1 speech output of the EXISTING web voice flow (Android WebView has no speechSynthesis engine; the app's
 *    shim forwards it to the phone's system TTS — the same engine Chrome uses): {source:'bookkaro-app',
 *    type:'BK_TTS_SPEAK', id, text, lang, rate} | {source:'bookkaro-app', type:'BK_TTS_CANCEL'}.
 *  IRCTC page → native (chrome.runtime shim): {id, msg:{type:'BK_GET_SNAPSHOT'|'BK_EVENT'|'BK_CLEAR'|'BK_STATUS'}};
 *    events carry metadata keys only (no field values, no PII).
 * No URL, file, shell, credential or script operation exists in this protocol.
 */
object BridgeProtocol {
    const val MAX_MESSAGE_CHARS = 16_000
    val HANDOFF_ID_RE = Regex("^irh_[0-9a-f-]{36}$")
    val BRIDGE_TOKEN_RE = Regex("^[0-9a-f]{64}$")
    val SAFE_EVENT_KEYS = setOf("type", "page", "filled", "skipped", "field", "language")
    const val MAX_TTS_CHARS = 3_900          // below TextToSpeech.getMaxSpeechInputLength() (4000)
    val TTS_LANG_RE = Regex("^[a-z]{2,3}(-[A-Z]{2})?$")
    val TERMINAL = setOf("COMPLETED", "BOOKING_FAILED", "BOOKING_STATUS_UNKNOWN", "EXPIRED", "STALE_HANDOFF", "STOPPED")

    sealed class AppMsg {
        object Ping : AppMsg()
        data class Register(val handoffId: String, val bridgeToken: String, val reviewVersion: Long) : AppMsg() {
            override fun toString() = "Register(handoffId=$handoffId, reviewVersion=$reviewVersion)"   // token never printed
        }
        data class Invalid(val code: String) : AppMsg()
        data class TtsSpeak(val id: Long, val text: String, val lang: String, val rate: Double) : AppMsg() {
            override fun toString() = "TtsSpeak(id=$id, chars=${text.length}, lang=$lang)"            // spoken text never printed
        }
        object TtsCancel : AppMsg()
    }

    sealed class IrctcMsg(open val id: Long) {
        data class GetSnapshot(override val id: Long) : IrctcMsg(id)
        data class Event(override val id: Long, val event: Map<String, Any?>) : IrctcMsg(id)
        data class Clear(override val id: Long) : IrctcMsg(id)
        data class Status(override val id: Long) : IrctcMsg(id)
        data class Invalid(override val id: Long, val code: String) : IrctcMsg(id)
    }

    private fun parseObj(raw: String?): Map<*, *>? {
        if (raw == null || raw.length > MAX_MESSAGE_CHARS) return null
        return try { Json.parse(raw) as? Map<*, *> } catch (e: Exception) { null }
    }

    fun parseApp(raw: String?): AppMsg {
        val d = parseObj(raw) ?: return AppMsg.Invalid("INVALID_MESSAGE")
        if (d["source"] != "bookkaro-app") return AppMsg.Invalid("INVALID_MESSAGE")
        return when (d["type"]) {
            "BK_PING" -> AppMsg.Ping
            "BK_IRCTC_HANDOFF" -> {
                val id = d["handoffId"]
                val tok = d["bridgeToken"]
                val rv = d["reviewVersion"]
                val rvL: Long? = when {
                    rv is Long -> rv
                    rv is Double && Math.floor(rv) == rv -> rv.toLong()
                    else -> null
                }
                if (id !is String || !HANDOFF_ID_RE.matches(id) || tok !is String || !BRIDGE_TOKEN_RE.matches(tok) || rvL == null || rvL < 1) AppMsg.Invalid("INVALID_HANDOFF")
                else AppMsg.Register(id, tok, rvL)
            }
            "BK_TTS_SPEAK" -> {
                val id = d["id"] as? Long
                val text = d["text"]
                val lang = d["lang"]
                val rate = when (val r = d["rate"]) { null -> 1.0; is Long -> r.toDouble(); is Double -> r; else -> Double.NaN }
                if (id == null || id < 1 || id > Int.MAX_VALUE || text !is String || text.isBlank() || text.length > MAX_TTS_CHARS ||
                    lang !is String || !TTS_LANG_RE.matches(lang) || rate.isNaN() || rate < 0.25 || rate > 4.0) AppMsg.Invalid("INVALID_TTS")
                else AppMsg.TtsSpeak(id, text, lang, rate)
            }
            "BK_TTS_CANCEL" -> AppMsg.TtsCancel
            else -> AppMsg.Invalid("UNKNOWN_MESSAGE")
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun parseIrctc(raw: String?): IrctcMsg {
        val d = parseObj(raw) ?: return IrctcMsg.Invalid(0, "INVALID_MESSAGE")
        val id = d["id"] as? Long ?: return IrctcMsg.Invalid(0, "INVALID_MESSAGE")
        val msg = d["msg"] as? Map<*, *> ?: return IrctcMsg.Invalid(id, "INVALID_MESSAGE")
        return when (msg["type"]) {
            "BK_GET_SNAPSHOT" -> IrctcMsg.GetSnapshot(id)
            "BK_EVENT" -> {
                val ev = msg["event"] as? Map<String, Any?> ?: return IrctcMsg.Invalid(id, "INVALID_EVENT")
                if (ev.keys.any { it !in SAFE_EVENT_KEYS }) IrctcMsg.Invalid(id, "INVALID_EVENT") else IrctcMsg.Event(id, ev)
            }
            "BK_CLEAR" -> IrctcMsg.Clear(id)
            "BK_STATUS" -> IrctcMsg.Status(id)
            else -> IrctcMsg.Invalid(id, "UNKNOWN_MESSAGE")
        }
    }

    fun reply(id: Long, body: Map<String, Any?>): String = Json.write(mapOf("id" to id, "body" to body))
}
