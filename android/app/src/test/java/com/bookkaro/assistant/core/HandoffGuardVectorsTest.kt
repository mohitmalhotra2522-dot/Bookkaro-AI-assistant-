package com.bookkaro.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** P40 G2 — the Kotlin guard returns exactly what the extension's JS guard returns, for every generated vector. */
class HandoffGuardVectorsTest {
    @Suppress("UNCHECKED_CAST")
    @Test fun everyVectorMatchesTheJsGuard() {
        assertTrue(Vectors.cases.size >= 28)
        for (c in Vectors.cases) {
            val name = c["name"] as String
            val js = c["result"] as Map<String, Any?>
            val kt = HandoffGuard.guard(c["snapshot"], Vectors.expected(name), c["key"] as String, (c["now"] as Number).toLong())
            assertEquals(name, js["ok"], kt.ok)
            assertEquals(name, js["code"], kt.code)
            assertEquals(name, js["reason"], kt.reason)
            assertEquals(name, js["detail"], kt.detail)
            if (kt.ok) assertEquals(name, c["snapshot"], kt.snapshot)
        }
    }

    @Test fun integrityPayloadIsByteIdenticalToJs() {
        assertEquals(Vectors.root["integrityPayloadOfValid"], HandoffGuard.integrityPayload(Vectors.snapshot("valid")))
    }

    @Suppress("UNCHECKED_CAST")
    @Test fun canonicalJsonMatchesJsForUnicodeEscapesNumbersAndKeyOrder() {
        for (c in Vectors.root["canonicalCases"] as List<Map<String, Any?>>) assertEquals(c["canonical"], Json.canonical(c["input"]))
    }

    @Test fun namedOutcomes() {
        val v = Vectors
        @Suppress("UNCHECKED_CAST")
        fun reason(n: String) = (v.case(n)["result"] as Map<*, *>)["reason"]
        fun kt(n: String) = HandoffGuard.guard(v.snapshot(n), v.expected(n), v.key(n), v.now(n))
        assertTrue(kt("valid").ok)
        assertEquals("EXPIRED", kt("expired_by_clock").reason); assertEquals("EXPIRED", reason("expired_by_clock"))
        assertEquals("EXPIRED", kt("expired_at_exact_expiry").reason)
        assertEquals("REVIEW_VERSION_MISMATCH", kt("stale_review_version").reason)
        assertEquals("HANDOFF_MISMATCH", kt("other_handoff_id").reason)
        assertEquals("INTEGRITY_FAILED", kt("wrong_key_other_session").reason)
        assertEquals("INTEGRITY_FAILED", kt("invalid_signature").reason)
        assertEquals("INTEGRITY_FAILED", kt("tampered_passenger_name").reason)
        assertEquals("STALE_HANDOFF", kt("backend_status_stale").reason)
        // an empty / missing key never verifies
        assertEquals("INTEGRITY_FAILED", HandoffGuard.guard(v.snapshot("valid"), v.expected(), "", v.now()).reason)
        assertEquals("INTEGRITY_FAILED", HandoffGuard.guard(v.snapshot("valid"), v.expected(), null, v.now()).reason)
        assertEquals("UNKNOWN_HANDOFF", HandoffGuard.reasonForHttp("HTTP_404"))
        assertEquals("SESSION_MISMATCH", HandoffGuard.reasonForHttp("BRIDGE_TOKEN_INVALID"))
    }
}
