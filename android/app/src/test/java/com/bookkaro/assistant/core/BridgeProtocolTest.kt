package com.bookkaro.assistant.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** P40 G2 — the bridges accept only the predefined messages; nothing else is executed. */
class BridgeProtocolTest {
    private val id = "irh_8c72c76b-6255-4ac8-9b0a-4cfd4bf47f60"
    private val tok = "a".repeat(64)

    @Test fun appBridgeAcceptsOnlyPingAndHandoff() {
        assertEquals(BridgeProtocol.AppMsg.Ping, BridgeProtocol.parseApp("""{"source":"bookkaro-app","type":"BK_PING"}"""))
        val r = BridgeProtocol.parseApp("""{"source":"bookkaro-app","type":"BK_IRCTC_HANDOFF","handoffId":"$id","bridgeToken":"$tok","reviewVersion":3}""")
        assertEquals(BridgeProtocol.AppMsg.Register(id, tok, 3), r)
        assertFalse("token never printed", r.toString().contains(tok))
        fun code(raw: String?) = (BridgeProtocol.parseApp(raw) as BridgeProtocol.AppMsg.Invalid).code
        assertEquals("INVALID_MESSAGE", code(null))
        assertEquals("INVALID_MESSAGE", code("not json"))
        assertEquals("INVALID_MESSAGE", code("""{"type":"BK_PING"}"""))                                  // wrong / missing source
        assertEquals("UNKNOWN_MESSAGE", code("""{"source":"bookkaro-app","type":"OPEN_URL","url":"https://evil.example"}"""))
        assertEquals("UNKNOWN_MESSAGE", code("""{"source":"bookkaro-app","type":"EXEC_JS","code":"alert(1)"}"""))
        assertEquals("INVALID_HANDOFF", code("""{"source":"bookkaro-app","type":"BK_IRCTC_HANDOFF","handoffId":"x","bridgeToken":"$tok","reviewVersion":3}"""))
        assertEquals("INVALID_HANDOFF", code("""{"source":"bookkaro-app","type":"BK_IRCTC_HANDOFF","handoffId":"$id","bridgeToken":"short","reviewVersion":3}"""))
        assertEquals("INVALID_HANDOFF", code("""{"source":"bookkaro-app","type":"BK_IRCTC_HANDOFF","handoffId":"$id","bridgeToken":"$tok","reviewVersion":0}"""))
        assertEquals("INVALID_HANDOFF", code("""{"source":"bookkaro-app","type":"BK_IRCTC_HANDOFF","handoffId":"$id","bridgeToken":"$tok","reviewVersion":1.5}"""))
        assertEquals("INVALID_MESSAGE", code("{\"source\":\"bookkaro-app\",\"type\":\"BK_PING\",\"pad\":\"" + "x".repeat(BridgeProtocol.MAX_MESSAGE_CHARS) + "\"}"))
    }

    @Test fun irctcBridgeAcceptsOnlyTheFourExtensionMessagesAndMetadataEvents() {
        assertEquals(BridgeProtocol.IrctcMsg.GetSnapshot(1), BridgeProtocol.parseIrctc("""{"id":1,"msg":{"type":"BK_GET_SNAPSHOT"}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Clear(2), BridgeProtocol.parseIrctc("""{"id":2,"msg":{"type":"BK_CLEAR"}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Status(3), BridgeProtocol.parseIrctc("""{"id":3,"msg":{"type":"BK_STATUS"}}"""))
        val ev = BridgeProtocol.parseIrctc("""{"id":4,"msg":{"type":"BK_EVENT","event":{"type":"FIELDS_FILLED","page":"HOME_SEARCH","filled":["from"],"skipped":[]}}}""")
        assertTrue(ev is BridgeProtocol.IrctcMsg.Event)
        assertEquals(BridgeProtocol.IrctcMsg.Invalid(5, "INVALID_EVENT"), BridgeProtocol.parseIrctc("""{"id":5,"msg":{"type":"BK_EVENT","event":{"type":"X","value":"Rahul"}}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Invalid(6, "INVALID_EVENT"), BridgeProtocol.parseIrctc("""{"id":6,"msg":{"type":"BK_EVENT","event":{"type":"X","password":"p"}}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Invalid(7, "UNKNOWN_MESSAGE"), BridgeProtocol.parseIrctc("""{"id":7,"msg":{"type":"BK_REGISTER_HANDOFF","bridgeToken":"x"}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Invalid(0, "INVALID_MESSAGE"), BridgeProtocol.parseIrctc("""{"msg":{"type":"BK_GET_SNAPSHOT"}}"""))
        assertEquals(BridgeProtocol.IrctcMsg.Invalid(8, "INVALID_MESSAGE"), BridgeProtocol.parseIrctc("""{"id":8}"""))
        assertEquals("""{"id":9,"body":{"ok":true}}""", BridgeProtocol.reply(9, mapOf("ok" to true)))
    }
}
