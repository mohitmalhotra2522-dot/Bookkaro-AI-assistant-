package com.bookkaro.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** P40 G2 — host / path / scheme / port rules identical to the JS isApprovedIrctcPage. */
class IrctcUrlPolicyTest {
    @Suppress("UNCHECKED_CAST")
    @Test fun matchesJsGuardForEveryUrl() {
        val cases = Vectors.root["urlCases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 20)
        for (c in cases) {
            val js = c["result"] as Map<String, Any?>
            val kt = IrctcUrlPolicy.isApprovedIrctcPage(c["url"] as String, allowMock = true)
            assertEquals(c["url"] as String, js["ok"], kt.ok)
            assertEquals(c["url"] as String, js["kind"], kt.kind)
            assertEquals(c["url"] as String, js["code"], kt.code)
        }
    }

    @Test fun releaseBuildRejectsMock() {
        assertFalse(IrctcUrlPolicy.isApprovedIrctcPage("http://localhost:3000/api/dev/mock-irctc/real-search", allowMock = false).ok)
        assertEquals(setOf(IrctcUrlPolicy.IRCTC_ORIGIN), IrctcUrlPolicy.irctcOrigins(allowMock = false))
        assertTrue(IrctcUrlPolicy.isApprovedIrctcPage(IrctcUrlPolicy.IRCTC_START_URL, allowMock = false).ok)
    }

    @Test fun lookalikesAndSchemesRejected() {
        for (u in listOf("https://www.irctc.co.in.evil.com/nget/", "https://evilwww.irctc.co.in/nget/", "https://www.irctc.co.in@evil.com/nget/", "intent://x#Intent;end", "data:text/html,hi", null))
            assertFalse(u.toString(), IrctcUrlPolicy.isApprovedIrctcPage(u, allowMock = true).ok)
        assertEquals("https://www.irctc.co.in", IrctcUrlPolicy.originOf("https://WWW.irctc.co.in:443/nget/x"))
        assertEquals("http://localhost:3000", IrctcUrlPolicy.originOf("http://localhost:3000/api/dev/mock-irctc"))
    }
}
