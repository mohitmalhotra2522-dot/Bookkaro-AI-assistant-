package com.bookkaro.assistant.web

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.util.TypedValue
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.bookkaro.assistant.BuildConfig

/** P40 — shared WebView settings + small native UI pieces (no file / content access, no popups, no geolocation). */
object WebViews {
    fun configure(web: WebView, userAgentTag: String, thirdPartyCookies: Boolean = false) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString $userAgentTag"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, thirdPartyCookies)
    }

    /** Only https links ever leave the app (to the user's browser). */
    fun openExternal(ctx: Context, url: String) {
        if (!url.startsWith("https://")) return
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) { /* no browser — nothing to do */ }
    }

    /** Full-screen message + one action (network error, unsupported WebView, refused handoff). */
    class MessagePanel(ctx: Context) : LinearLayout(ctx) {
        val text = TextView(ctx)
        val action = Button(ctx)

        init {
            orientation = VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, ctx.resources.displayMetrics).toInt()
            setPadding(pad, pad, pad, pad)
            text.setTextColor(Color.parseColor("#1B1B1F"))
            text.textSize = 17f
            text.gravity = Gravity.CENTER
            addView(text, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            addView(action, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = pad })
            visibility = GONE
            isClickable = true
        }

        fun show(message: String, actionLabel: String, onAction: () -> Unit) {
            text.text = message
            action.text = actionLabel
            action.setOnClickListener { onAction() }
            visibility = VISIBLE
        }

        fun hide() { visibility = GONE }
    }

    fun banner(ctx: Context): TextView = TextView(ctx).apply {
        setBackgroundColor(Color.parseColor("#FFF4E5"))
        setTextColor(Color.parseColor("#5F3B00"))
        textSize = 13f
        val p = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 8f, ctx.resources.displayMetrics).toInt()
        setPadding(p * 2, p, p * 2, p)
        visibility = android.view.View.GONE
        layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP)
    }
}
