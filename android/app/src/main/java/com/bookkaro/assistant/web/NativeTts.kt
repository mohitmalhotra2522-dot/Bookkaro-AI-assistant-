package com.bookkaro.assistant.web

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.bookkaro.assistant.core.BridgeProtocol
import java.util.Locale

/**
 * P40.1 — speech output for the EXISTING BookKaro web voice flow inside the app.
 * Android System WebView exposes `speechSynthesis` without any engine behind it, so replies were silent in the app while
 * Chrome (which uses the phone's system TTS) spoke them. The BookKaro page's shim hands each utterance here and this
 * class speaks it with the SAME system TTS engine. No new TTS provider, no network, no storage; text is never logged.
 * Events go back to the page as "start" | "end" | "interrupted" | "error" (the page treats error like before:
 * text stays visible in chat).
 */
class NativeTts(ctx: Context, private val onEvent: (id: Long, event: String) -> Unit) : TextToSpeech.OnInitListener {
    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayDeque<BridgeProtocol.AppMsg.TtsSpeak>()
    private var ready = false
    private var failed = false
    private var shutdown = false
    private val tts = TextToSpeech(ctx.applicationContext, this)

    override fun onInit(status: Int) { main.post { initDone(status) } }

    private fun initDone(status: Int) {
        if (shutdown) return
        if (status != TextToSpeech.SUCCESS) {
            failed = true
            while (pending.isNotEmpty()) onEvent(pending.removeFirst().id, "error")
            return
        }
        ready = true
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = post(utteranceId, "start")
            override fun onDone(utteranceId: String) = post(utteranceId, "end")
            @Deprecated("Deprecated in Java") override fun onError(utteranceId: String) = post(utteranceId, "error")
            override fun onError(utteranceId: String, errorCode: Int) = post(utteranceId, "error")
            override fun onStop(utteranceId: String, interrupted: Boolean) = post(utteranceId, "interrupted")
        })
        while (pending.isNotEmpty()) doSpeak(pending.removeFirst())
    }

    private fun post(utteranceId: String, event: String) {
        val id = utteranceId.removePrefix("bk-").toLongOrNull() ?: return
        main.post { if (!shutdown) onEvent(id, event) }
    }

    /** Main thread. Queued like speechSynthesis.speak (QUEUE_ADD). */
    fun speak(m: BridgeProtocol.AppMsg.TtsSpeak) {
        when {
            shutdown -> return
            failed -> onEvent(m.id, "error")
            !ready -> pending.addLast(m)
            else -> doSpeak(m)
        }
    }

    private fun doSpeak(m: BridgeProtocol.AppMsg.TtsSpeak) {
        val wanted = Locale.forLanguageTag(m.lang)
        var r = tts.setLanguage(wanted)
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) r = tts.setLanguage(Locale(wanted.language))
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) { onEvent(m.id, "error"); return }
        tts.setSpeechRate(m.rate.toFloat())
        if (tts.speak(m.text, TextToSpeech.QUEUE_ADD, null, "bk-${m.id}") != TextToSpeech.SUCCESS) onEvent(m.id, "error")
    }

    /** speechSynthesis.cancel(): drop the queue and stop the current utterance. */
    fun cancel() {
        pending.clear()
        if (ready) tts.stop()
    }

    fun shutdown() {
        shutdown = true
        pending.clear()
        try { tts.stop(); tts.shutdown() } catch (e: Exception) { /* engine already gone */ }
    }
}
