package com.bookkaro.assistant.core

/**
 * P40 — native owner of the ONE active IRCTC handoff (memory only: a process death = no handoff = no replay).
 * register(): BookKaro page "Continue to IRCTC" → fetch the signed P39.3 snapshot → full guard → only a valid, live,
 * non-terminal handoff becomes active. Every BK_GET_SNAPSHOT from the IRCTC page re-fetches + re-guards (each IRCTC
 * step), only for the approved IRCTC page; a stale refusal drops the handoff (never retried with stale data).
 * The bridge token stays here — the IRCTC page only ever receives the validated booking fields.
 */
class HandoffController(
    private val backend: Backend,
    private val clock: () -> Long = System::currentTimeMillis,
    private val allowMock: Boolean = false
) {
    interface Backend {
        fun getSnapshot(handoffId: String, bridgeToken: String): HttpResult
        fun postEvent(handoffId: String, bridgeToken: String, eventJson: String): HttpResult
    }

    data class HttpResult(val status: Int, val body: Map<String, Any?>?)

    private data class Active(val handoffId: String, val bridgeToken: String, val reviewVersion: Long, val registeredAt: Long) {
        override fun toString() = "Active(handoffId=$handoffId, reviewVersion=$reviewVersion)"   // token never printed
    }

    private val lock = Any()
    @Volatile private var active: Active? = null
    @Volatile var lastPage: String? = null
        private set

    fun hasActive(): Boolean = active != null
    fun activeHandoffId(): String? = active?.handoffId

    fun clear() = synchronized(lock) { active = null; lastPage = null }

    private fun httpCode(r: HttpResult): String = (r.body?.get("code") as? String) ?: "HTTP_${r.status}"

    private fun fetchGuarded(a: Active): Map<String, Any?> = try {
        val r = backend.getSnapshot(a.handoffId, a.bridgeToken)
        if (r.status in 200..299 && r.body != null) {
            val g = HandoffGuard.guard(r.body, HandoffGuard.Expected(a.handoffId, a.reviewVersion), a.bridgeToken, clock())
            if (g.ok) mapOf("ok" to true, "body" to g.snapshot) else mapOf("ok" to false, "code" to g.code, "reason" to g.reason)
        } else {
            val code = httpCode(r)
            val reason = HandoffGuard.reasonForHttp(code)
            if (reason != null) mapOf("ok" to false, "code" to "STALE_IRCTC_HANDOFF", "reason" to reason) else mapOf("ok" to false, "code" to code)
        }
    } catch (e: Exception) {
        mapOf("ok" to false, "code" to "NETWORK_ERROR")   // never reported as success
    }

    /** "Continue to IRCTC" from the BookKaro page: bind, fetch, guard. Only a valid, live, non-terminal handoff stays active. */
    fun register(m: BridgeProtocol.AppMsg.Register): Map<String, Any?> = synchronized(lock) {
        val a = Active(m.handoffId, m.bridgeToken, m.reviewVersion, clock())
        val r = fetchGuarded(a)
        if (r["ok"] != true) { active = null; return r }
        @Suppress("UNCHECKED_CAST") val snap = r["body"] as Map<String, Any?>
        val status = snap["status"] as String
        if (status in BridgeProtocol.TERMINAL) { active = null; return mapOf("ok" to false, "code" to "STALE_IRCTC_HANDOFF", "reason" to "HANDOFF_FINISHED", "status" to status) }
        active = a; lastPage = null
        mapOf("ok" to true, "status" to status, "mockData" to snap["mockData"])
    }

    /** BK_GET_SNAPSHOT from the IRCTC WebView (pageUrl = the WebView's current main-frame URL, read natively). */
    fun snapshotFor(pageUrl: String?): Map<String, Any?> {
        if (!IrctcUrlPolicy.isApprovedIrctcPage(pageUrl, allowMock).ok) return mapOf("ok" to false, "code" to "UNAUTHORIZED_IRCTC_HOST")
        val a = active ?: return mapOf("ok" to false, "code" to "NO_ACTIVE_HANDOFF")
        val r = fetchGuarded(a)
        if (r["code"] == "STALE_IRCTC_HANDOFF") synchronized(lock) { if (active == a) active = null }   // never retried with stale data
        return r
    }

    /** BK_EVENT (metadata keys only, already filtered by BridgeProtocol). */
    fun event(pageUrl: String?, event: Map<String, Any?>): Map<String, Any?> {
        if (!IrctcUrlPolicy.isApprovedIrctcPage(pageUrl, allowMock).ok) return mapOf("ok" to false, "code" to "UNAUTHORIZED_IRCTC_HOST")
        if (event.keys.any { it !in BridgeProtocol.SAFE_EVENT_KEYS }) return mapOf("ok" to false, "code" to "INVALID_EVENT")
        val a = active ?: return mapOf("ok" to false, "code" to "NO_ACTIVE_HANDOFF")
        (event["page"] as? String)?.let { if (event["type"] == "PAGE_DETECTED") lastPage = it }
        val r = try { backend.postEvent(a.handoffId, a.bridgeToken, Json.write(event)) } catch (e: Exception) { return mapOf("ok" to false, "code" to "NETWORK_ERROR") }
        return if (r.status in 200..299) mapOf("ok" to true, "body" to r.body) else mapOf("ok" to false, "code" to httpCode(r))
    }

    fun status(): Map<String, Any?> = mapOf("ok" to true, "active" to (active != null), "handoffId" to active?.handoffId)

    /** Dispatch one parsed IRCTC-page message. */
    fun handle(msg: BridgeProtocol.IrctcMsg, pageUrl: String?): Map<String, Any?> = when (msg) {
        is BridgeProtocol.IrctcMsg.GetSnapshot -> snapshotFor(pageUrl)
        is BridgeProtocol.IrctcMsg.Event -> event(pageUrl, msg.event)
        is BridgeProtocol.IrctcMsg.Clear -> { clear(); mapOf("ok" to true) }
        is BridgeProtocol.IrctcMsg.Status -> status()
        is BridgeProtocol.IrctcMsg.Invalid -> mapOf("ok" to false, "code" to msg.code)
    }
}
