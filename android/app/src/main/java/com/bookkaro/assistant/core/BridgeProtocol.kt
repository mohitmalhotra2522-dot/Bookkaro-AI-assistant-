package com.bookkaro.assistant.core

/**
 * P40 — the ONLY messages the two WebView bridges accept (everything else → Invalid, nothing executed):
 *  BookKaro page → native: {source:'bookkaro-app', type:'BK_PING'} | {source:'bookkaro-app', type:'BK_IRCTC_HANDOFF',
 *    handoffId, bridgeToken, reviewVersion} (the same three P39.3 binding values the desktop extension receives).
 *  IRCTC page → native (chrome.runtime shim): {id, msg:{type:'BK_GET_SNAPSHOT'|'BK_EVENT'|'BK_CLEAR'|'BK_STATUS'}};
 *    events carry metadata keys only (no field values, no PII).
 * No URL, file, shell, credential or script operation exists in this protocol.
 */
object BridgeProtocol {
    const val MAX_MESSAGE_CHARS = 16_000
    val HANDOFF_ID_RE = Regex("^irh_[0-9a-f-]{36}$")
    val BRIDGE_TOKEN_RE = Regex("^[0-9a-f]{64}$")
    val SAFE_EVENT_KEYS = setOf("type", "page", "filled", "skipped", "field", "language")
    val TERMINAL = setOf("COMPLETED", "BOOKING_FAILED", "BOOKING_STATUS_UNKNOWN", "EXPIRED", "STALE_HANDOFF", "STOPPED")

    sealed class AppMsg {
        object Ping : AppMsg()
        data class Register(val handoffId: String, val bridgeToken: String, val reviewVersion: Long) : AppMsg() {
            override fun toString() = "Register(handoffId=$handoffId, reviewVersion=$reviewVersion)"   // token never printed
        }
        data class Invalid(val code: String) : AppMsg()
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
