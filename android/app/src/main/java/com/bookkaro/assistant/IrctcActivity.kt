package com.bookkaro.assistant

import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.bookkaro.assistant.core.BridgeProtocol
import com.bookkaro.assistant.core.HandoffController
import com.bookkaro.assistant.core.InjectedScript
import com.bookkaro.assistant.core.IrctcUrlPolicy
import com.bookkaro.assistant.core.NavigationPolicy
import com.bookkaro.assistant.web.AppGraph
import com.bookkaro.assistant.web.WebViews

/**
 * P40 — native IRCTC WebView. Opens https://www.irctc.co.in/nget/train-search only when a verified handoff is active.
 * The ONE injected script (adapter + unmodified extension files) and the `BookKaroIrctc` bridge are restricted to the
 * IRCTC origin (debug: + local MockIRCTC); messages from sub-frames / other origins get UNAUTHORIZED_IRCTC_HOST.
 * Off the approved /nget/ pages: no autofill, no data (banner shown). Login / CAPTCHA / OTP / payment: the user's own.
 * Finishing this screen clears the handoff (never replayed).
 */
class IrctcActivity : ComponentActivity() {
    companion object { const val EXTRA_MOCK = "mock" }

    private val allowMock = AppGraph.allowMock
    private lateinit var web: WebView
    private lateinit var panel: WebViews.MessagePanel
    private lateinit var banner: TextView
    @Volatile private var currentUrl: String? = null
    private var webReady = false
    private val controller: HandoffController get() = AppGraph.controller

    private fun startUrl(): String {
        val origin = BuildConfig.BOOKKARO_ORIGIN.trimEnd('/')
        val mock = "$origin/api/dev/mock-irctc/real-search"
        if (allowMock && intent.getBooleanExtra(EXTRA_MOCK, false) && IrctcUrlPolicy.isApprovedIrctcPage(mock, true).kind == "MOCK") return mock
        return IrctcUrlPolicy.IRCTC_START_URL
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this)
        web = WebView(this)
        panel = WebViews.MessagePanel(this)
        banner = WebViews.banner(this)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(banner)
        root.addView(panel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (panel.visibility != View.VISIBLE && web.canGoBack()) web.goBack() else finish() }
        })

        // process recreated / handoff consumed or expired → nothing to open, nothing replayed
        if (!controller.hasActive()) { panel.show(getString(R.string.handoff_missing), getString(R.string.back_to_bookkaro)) { finish() }; return }
        // no secure way to restrict the script + bridge to IRCTC on this WebView → refuse (no insecure fallback)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            panel.show(getString(R.string.webview_too_old), getString(R.string.back_to_bookkaro)) { finish() }; return
        }

        WebViews.configure(web, "BookKaroAndroid/${BuildConfig.VERSION_NAME}")
        val origins = IrctcUrlPolicy.irctcOrigins(allowMock)
        WebViewCompat.addWebMessageListener(web, "BookKaroIrctc", origins) { _, message, sourceOrigin, isMainFrame, reply ->
            val msg = BridgeProtocol.parseIrctc(message.data)
            val pageUrl = currentUrl
            val sameOrigin = IrctcUrlPolicy.originOf(sourceOrigin.toString()) == IrctcUrlPolicy.originOf(pageUrl)
            if (!isMainFrame || !sameOrigin) { reply.postMessage(BridgeProtocol.reply(msg.id, mapOf("ok" to false, "code" to "UNAUTHORIZED_IRCTC_HOST"))); return@addWebMessageListener }
            AppGraph.io.execute {
                val body = controller.handle(msg, pageUrl)
                runOnUiThread { if (!isDestroyed) reply.postMessage(BridgeProtocol.reply(msg.id, body)) }
            }
        }
        val script = InjectedScript.build({ name -> assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() } }, AppGraph.VERSION)
        WebViewCompat.addDocumentStartJavaScript(web, script, origins)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (NavigationPolicy.forIrctc(url, controller.lastPage, allowMock)) {
                    NavigationPolicy.Decision.LOAD_IN_WEBVIEW -> false
                    NavigationPolicy.Decision.OPEN_EXTERNAL -> { WebViews.openExternal(this@IrctcActivity, url); true }
                    NavigationPolicy.Decision.BLOCK -> true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { track(url); panel.hide() }
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { track(url) }   // SPA route changes

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) panel.show(getString(R.string.irctc_load_failed), getString(R.string.retry)) { panel.hide(); web.reload() }
            }
        }
        webReady = true
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(startUrl())
    }

    private fun track(url: String?) {
        currentUrl = url
        val approved = IrctcUrlPolicy.isApprovedIrctcPage(url, allowMock).ok
        banner.text = getString(R.string.autofill_off_here)
        banner.visibility = if (approved || url == null) View.GONE else View.VISIBLE
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (webReady) web.saveState(outState) }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() {
        if (isFinishing) controller.clear()   // leaving the IRCTC screen ends this handoff (rotation keeps it)
        web.destroy()
        super.onDestroy()
    }
}
