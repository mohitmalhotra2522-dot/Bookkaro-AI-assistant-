package com.bookkaro.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.bookkaro.assistant.core.BridgeProtocol
import com.bookkaro.assistant.core.IrctcUrlPolicy
import com.bookkaro.assistant.core.Json
import com.bookkaro.assistant.core.NavigationPolicy
import com.bookkaro.assistant.web.AppGraph
import com.bookkaro.assistant.web.WebViews

/**
 * P40 — the BookKaro web app (unchanged React app) in a WebView on the HTTPS production URL.
 * Bridge `BookKaroAndroid` (WebMessageListener, BookKaro origin + main frame only): BK_PING → BK_ANDROID_READY;
 * BK_IRCTC_HANDOFF → native fetch + guard of the signed P39.3 snapshot → IrctcActivity. Nothing else.
 * Microphone: only for the BookKaro origin, only after the normal Android runtime permission (existing voice flow).
 */
class MainActivity : ComponentActivity() {
    private val bookkaroOrigin = BuildConfig.BOOKKARO_ORIGIN.trimEnd('/')
    private lateinit var web: WebView
    private lateinit var panel: WebViews.MessagePanel
    private var pendingMic: PermissionRequest? = null

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val req = pendingMic
        pendingMic = null
        if (req != null) { if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this)
        web = WebView(this)
        panel = WebViews.MessagePanel(this)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(panel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)

        WebViews.configure(web, "BookKaroAndroid/${BuildConfig.VERSION_NAME}")
        web.settings.mediaPlaybackRequiresUserGesture = false   // TTS replies of the existing voice flow
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (NavigationPolicy.forBookKaro(url, bookkaroOrigin)) {
                    NavigationPolicy.Decision.LOAD_IN_WEBVIEW -> false
                    NavigationPolicy.Decision.OPEN_EXTERNAL -> { WebViews.openExternal(this@MainActivity, url); true }
                    NavigationPolicy.Decision.BLOCK -> true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { panel.hide() }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) panel.show(getString(R.string.bookkaro_load_failed), getString(R.string.retry)) { panel.hide(); web.reload() }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val fromBookKaro = IrctcUrlPolicy.originOf(request.origin.toString()) == bookkaroOrigin
                val onlyMic = request.resources.isNotEmpty() && request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!fromBookKaro || !onlyMic) { request.deny(); return }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingMic?.deny()
                    pendingMic = request
                    micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    return
                }
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "BookKaroAndroid", setOf(bookkaroOrigin)) { _, message, sourceOrigin, isMainFrame, reply ->
                if (!isMainFrame || IrctcUrlPolicy.originOf(sourceOrigin.toString()) != bookkaroOrigin) return@addWebMessageListener
                onAppMessage(message.data, reply)
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (panel.visibility == android.view.View.VISIBLE) { panel.hide(); return }
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(BuildConfig.BOOKKARO_URL)
    }

    private fun send(reply: JavaScriptReplyProxy, body: Map<String, Any?>) {
        reply.postMessage(Json.write(mapOf("source" to "bookkaro-android") + body))
    }

    private fun onAppMessage(raw: String?, reply: JavaScriptReplyProxy) {
        when (val m = BridgeProtocol.parseApp(raw)) {
            is BridgeProtocol.AppMsg.Ping -> send(reply, mapOf("type" to "BK_ANDROID_READY", "version" to AppGraph.VERSION))
            is BridgeProtocol.AppMsg.Invalid -> send(reply, mapOf("type" to "BK_IRCTC_HANDOFF_ACK", "ok" to false, "code" to m.code))
            is BridgeProtocol.AppMsg.Register -> AppGraph.io.execute {
                val r = AppGraph.controller.register(m)
                runOnUiThread {
                    if (isDestroyed) return@runOnUiThread
                    send(reply, mapOf("type" to "BK_IRCTC_HANDOFF_ACK", "ok" to (r["ok"] == true), "code" to r["code"], "reason" to r["reason"], "status" to r["status"]))
                    if (r["ok"] == true) startActivity(Intent(this, IrctcActivity::class.java).putExtra(IrctcActivity.EXTRA_MOCK, r["mockData"] == true))
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
