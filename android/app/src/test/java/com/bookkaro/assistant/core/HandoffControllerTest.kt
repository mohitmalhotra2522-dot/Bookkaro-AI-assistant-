package com.bookkaro.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P40 G2 — native handoff controller with a fake backend serving the REAL signed snapshot from the vectors
 * (valid / expired / wrong session / stale review / bad signature / host / replay / re-verify / events / network).
 */
class HandoffControllerTest {
    private val irctc = "https://www.irctc.co.in/nget/train-search"
    private val valid = Vectors.snapshot("valid")
    private val handoffId = Vectors.expected().handoffId

    private class FakeBackend(var snapshot: () -> HandoffController.HttpResult) : HandoffController.Backend {
        var gets = 0
        val events = mutableListOf<String>()
        var eventResult: () -> HandoffController.HttpResult = { HandoffController.HttpResult(200, mapOf("view" to mapOf("status" to "JOURNEY_PAGE"))) }
        override fun getSnapshot(handoffId: String, bridgeToken: String): HandoffController.HttpResult { gets++; return snapshot() }
        override fun postEvent(handoffId: String, bridgeToken: String, eventJson: String): HandoffController.HttpResult { events += eventJson; return eventResult() }
    }

    private fun ok(s: Map<String, Any?> = valid) = { HandoffController.HttpResult(200, s) }
    private fun reg(rv: Long = Vectors.expected().reviewVersion, key: String = Vectors.key(), id: String = handoffId) = BridgeProtocol.AppMsg.Register(id, key, rv)
    private fun controller(b: FakeBackend, now: Long = Vectors.now()) = HandoffController(b, { now }, allowMock = true)

    @Test fun validHandoffRegistersAndServesTheVerifiedSnapshotToTheApprovedIrctcPage() {
        val b = FakeBackend(ok())
        val c = controller(b)
        val r = c.register(reg())
        assertEquals(true, r["ok"]); assertEquals("READY", r["status"]); assertEquals(true, r["mockData"])
        assertTrue(c.hasActive())
        val s = c.snapshotFor(irctc)
        assertEquals(true, s["ok"])
        assertEquals(valid, s["body"])
        assertFalse("bridge token never sent to the page", Json.write(s).contains(Vectors.key()))
    }

    @Test fun expiredHandoffIsRefused() {
        val c = controller(FakeBackend(ok()), now = Vectors.now("expired_by_clock"))
        val r = c.register(reg())
        assertEquals("STALE_IRCTC_HANDOFF", r["code"]); assertEquals("EXPIRED", r["reason"])
        assertFalse(c.hasActive())
        assertEquals("EXPIRED", controller(FakeBackend(ok(Vectors.snapshot("backend_status_expired")))).register(reg())["reason"])
    }

    @Test fun wrongSessionIsRefused() {
        // another session's token: the backend rejects it (401) …
        val c = controller(FakeBackend { HandoffController.HttpResult(401, mapOf("code" to "BRIDGE_TOKEN_INVALID")) })
        val r = c.register(reg())
        assertEquals("STALE_IRCTC_HANDOFF", r["code"]); assertEquals("SESSION_MISMATCH", r["reason"])
        // … and a snapshot signed for another session never verifies
        assertEquals("INTEGRITY_FAILED", controller(FakeBackend(ok())).register(reg(key = Vectors.key("wrong_key_other_session").reversed()))["reason"])
        assertEquals("UNKNOWN_HANDOFF", controller(FakeBackend { HandoffController.HttpResult(404, null) }).register(reg())["reason"])
        assertEquals("HANDOFF_MISMATCH", controller(FakeBackend(ok())).register(reg(id = "irh_00000000-0000-4000-8000-000000000000"))["reason"])
    }

    @Test fun staleReviewIsRefused() {
        val c = controller(FakeBackend(ok()))
        assertEquals("REVIEW_VERSION_MISMATCH", c.register(reg(rv = Vectors.expected().reviewVersion + 1))["reason"])
        assertFalse(c.hasActive())
        assertEquals("STALE_HANDOFF", controller(FakeBackend(ok(Vectors.snapshot("backend_status_stale")))).register(reg())["reason"])
    }

    @Test fun invalidSignatureIsRefused() {
        for (n in listOf("invalid_signature", "tampered_passenger_name", "tampered_train", "tampered_date", "tampered_class")) {
            val c = controller(FakeBackend(ok(Vectors.snapshot(n))))
            assertEquals(n, "INTEGRITY_FAILED", c.register(reg())["reason"])
            assertFalse(n, c.hasActive())
        }
    }

    @Test fun unapprovedPageGetsNothingAndTheBackendIsNotEvenCalled() {
        val b = FakeBackend(ok())
        val c = controller(b)
        c.register(reg())
        val before = b.gets
        for (u in listOf("https://evil.example/nget/", "https://www.irctc.co.in/eticketing/login", "https://www.irctc.co.in.attacker.example/nget/", "http://www.irctc.co.in/nget/train-search", null)) {
            assertEquals(u.toString(), "UNAUTHORIZED_IRCTC_HOST", c.snapshotFor(u)["code"])
            assertEquals(u.toString(), "UNAUTHORIZED_IRCTC_HOST", c.event(u, mapOf("type" to "PAGE_DETECTED", "page" to "LOGIN"))["code"])
        }
        assertEquals(before, b.gets)
        assertTrue(b.events.isEmpty())
        // release build: the MockIRCTC is not an approved page either
        val rel = HandoffController(b, { Vectors.now() }, allowMock = false)
        rel.register(reg())
        assertEquals("UNAUTHORIZED_IRCTC_HOST", rel.snapshotFor("http://localhost:3000/api/dev/mock-irctc/real-search")["code"])
    }

    @Test fun replayProtection() {
        // finished handoffs are refused at registration
        val done = controller(FakeBackend(ok(Vectors.snapshot("backend_status_completed_passthrough"))))
        val r = done.register(reg())
        assertEquals("HANDOFF_FINISHED", r["reason"]); assertEquals("COMPLETED", r["status"]); assertFalse(done.hasActive())
        // leaving the IRCTC screen clears it — nothing can be replayed afterwards
        val c = controller(FakeBackend(ok()))
        c.register(reg()); c.clear()
        assertEquals("NO_ACTIVE_HANDOFF", c.snapshotFor(irctc)["code"])
        assertNull(c.lastPage)
        // process death: a new controller knows no handoff (memory only)
        assertEquals("NO_ACTIVE_HANDOFF", controller(FakeBackend(ok())).snapshotFor(irctc)["code"])
        // BK_CLEAR from the page
        val d = controller(FakeBackend(ok())); d.register(reg())
        d.handle(BridgeProtocol.IrctcMsg.Clear(1), irctc)
        assertFalse(d.hasActive())
    }

    @Test fun everySnapshotRequestIsReverifiedBeforeEachStage() {
        val b = FakeBackend(ok())
        val c = controller(b)
        c.register(reg())
        assertEquals(true, c.snapshotFor(irctc)["ok"])
        assertEquals(true, c.snapshotFor("https://www.irctc.co.in/nget/booking/psgninput")["ok"])
        assertEquals(3, b.gets)                                         // register + one fetch per stage
        // the review changed on the backend (new signature / version) → refused and dropped, never retried
        b.snapshot = ok(Vectors.snapshot("tampered_passenger_name"))
        val s = c.snapshotFor(irctc)
        assertEquals("STALE_IRCTC_HANDOFF", s["code"]); assertEquals("INTEGRITY_FAILED", s["reason"])
        assertFalse(c.hasActive())
        b.snapshot = ok()
        assertEquals("NO_ACTIVE_HANDOFF", c.snapshotFor(irctc)["code"])
    }

    @Test fun eventsAreMetadataOnlyAndTrackTheIrctcPage() {
        val b = FakeBackend(ok())
        val c = controller(b)
        c.register(reg())
        assertEquals(true, c.event(irctc, mapOf("type" to "PAGE_DETECTED", "page" to "PAYMENT"))["ok"])
        assertEquals("PAYMENT", c.lastPage)
        assertEquals("INVALID_EVENT", c.event(irctc, mapOf("type" to "X", "value" to "Rahul Sharma"))["code"])
        assertEquals(1, b.events.size)
        assertFalse(b.events.single().contains("Rahul"))
        assertEquals("NO_ACTIVE_HANDOFF", controller(FakeBackend(ok())).event(irctc, mapOf("type" to "PAUSED"))["code"])
    }

    @Test fun networkFailureIsNeverReportedAsSuccess() {
        val c = controller(FakeBackend { throw java.io.IOException("offline") })
        val r = c.register(reg())
        assertEquals(false, r["ok"]); assertEquals("NETWORK_ERROR", r["code"]); assertFalse(c.hasActive())
        val b = FakeBackend(ok()); val d = controller(b); d.register(reg())
        b.snapshot = { throw java.io.IOException("offline") }
        assertEquals("NETWORK_ERROR", d.snapshotFor(irctc)["code"])
        b.eventResult = { throw java.io.IOException("offline") }
        assertEquals("NETWORK_ERROR", d.event(irctc, mapOf("type" to "PAUSED"))["code"])
        b.eventResult = { HandoffController.HttpResult(500, null) }
        assertEquals("HTTP_500", d.event(irctc, mapOf("type" to "PAUSED"))["code"])
    }
}
