package com.th3rumbl3.shelf

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.text.Html
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

private const val PICK = 1
private const val TREE = 2
private const val BG = 0xff17110c.toInt()

/**
 * shelf in a WebView. On Wi-Fi the app first tries shelf on the home network
 * and uses it when it answers; otherwise it goes through the public edge. The
 * choice is made again whenever the app comes back to the foreground, keeping
 * the current page. The settings page drives the phone's folder sync through
 * [Bridge].
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val chrome = Chrome()
    private val main = Handler(Looper.getMainLooper())
    private var base: String? = null
    private var chooser: ValueCallback<Array<Uri>>? = null
    /** the page in the main frame, for [Bridge] */
    @Volatile private var page: String? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        @Suppress("DEPRECATION")
        window.statusBarColor = 0xff120d08.toInt()
        @Suppress("DEPRECATION")
        window.navigationBarColor = BG
        // chrome://inspect for debug builds
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.setBackgroundColor(BG)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            userAgentString += " shelf-android/" + BuildConfig.VERSION_NAME
        }
        web.webViewClient = Client()
        web.webChromeClient = chrome
        web.setDownloadListener { url, agent, disposition, mime, _ -> download(url, agent, disposition, mime) }
        web.addJavascriptInterface(Bridge(), "ShelfApp")
        Sync.ensure(applicationContext)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        choose()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        web.onPause()
        super.onPause()
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        android.util.Log.i("shelf", "back: url=${web.url} canGoBack=${web.canGoBack()} list=${web.copyBackForwardList().size}")
        when {
            chrome.showing() -> chrome.onHideCustomView()
            web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    /** picks the LAN or the public address in the background, then [use]s it */
    private fun choose() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val local = caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        Thread {
            val url = if (local && isShelf(BuildConfig.LAN_URL)) BuildConfig.LAN_URL else BuildConfig.PUBLIC_URL
            main.post { use(url) }
        }.start()
    }

    /** whether shelf answers at [url]; the timeout is short, a foreign Wi-Fi costs little */
    private fun isShelf(url: String): Boolean = try {
        val c = URL("$url/").openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 1500
        c.instanceFollowRedirects = false
        try {
            c.responseCode == 200 && c.inputStream.bufferedReader().use { it.readText() }.contains("<title>shelf")
        } finally {
            c.disconnect()
        }
    } catch (e: IOException) {
        false
    }

    /** switches to [url], staying on the same page when there already is one */
    private fun use(url: String) {
        if (url == base) return
        val old = base
        val cur = web.url
        base = url
        val path = if (old != null && cur != null && cur.startsWith("$old/")) cur.substring(old.length) else "/"
        web.loadUrl(url + path)
    }

    private fun ours(url: String) =
        listOf(BuildConfig.LAN_URL, BuildConfig.PUBLIC_URL).any { url == it || url.startsWith("$it/") }

    private fun download(url: String, agent: String, disposition: String?, mime: String?) {
        if (!url.startsWith("http")) {
            toast("this cannot be downloaded in the app")
            return
        }
        val name = fileName(url, disposition, mime)
        val req = DownloadManager.Request(Uri.parse(url))
            .addRequestHeader("User-Agent", agent)
            .setMimeType(mime)
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
        getSystemService(DownloadManager::class.java).enqueue(req)
        toast("downloading $name")
    }

    /** the UTF-8 name shelf sends in filename*, else Android's guess */
    private fun fileName(url: String, disposition: String?, mime: String?): String {
        val star = disposition?.let { Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(it) }
        val name = star?.let { URLDecoder.decode(it.groupValues[1].replace("+", "%2B"), "UTF-8") }
            ?: URLUtil.guessFileName(url, disposition, mime)
        return name.replace('/', '_').ifBlank { "download" }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == TREE) {
            val uri = data?.data
            if (resultCode == RESULT_OK && uri != null) {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                Thread { event("picked", Sync.addFolder(applicationContext, uri).id.toString()) }.start()
            }
            return
        }
        if (requestCode != PICK) return super.onActivityResult(requestCode, resultCode, data)
        val clip = data?.clipData
        val uris = when {
            resultCode != RESULT_OK -> null
            clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            else -> WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        }
        chooser?.onReceiveValue(uris)
        chooser = null
    }

    /** tells the page: window.shelfAppEvent(what, arg) */
    private fun event(what: String, arg: String) = main.post {
        web.evaluateJavascript("window.shelfAppEvent && shelfAppEvent(${JSONObject.quote(what)}, $arg)", null)
    }

    /** phone sync for the settings page, as window.ShelfApp; only shelf's own pages get an answer */
    private inner class Bridge {
        private fun ok() = page?.let { ours(it) } == true

        @JavascriptInterface
        fun info(): String = if (ok()) Sync.info(applicationContext) else "{}"

        @JavascriptInterface
        fun pair(token: String, username: String, device: String, id: Long) {
            if (!ok()) return
            Sync.pair(applicationContext, token, username, device, id)
            // for the progress of "sync now"
            if (Build.VERSION.SDK_INT >= 33) main.post { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0) }
        }

        @JavascriptInterface
        fun unpair() {
            if (ok()) Sync.unpair(applicationContext, true)
        }

        @JavascriptInterface
        fun addFolder() {
            if (ok()) main.post {
                try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), TREE)
                } catch (e: ActivityNotFoundException) {
                    toast("this phone has no folder picker")
                }
            }
        }

        @JavascriptInterface
        fun setDest(id: Int, dest: String) {
            if (ok()) Sync.setDest(applicationContext, id, dest)
        }

        @JavascriptInterface
        fun removeFolder(id: Int) {
            if (ok()) Sync.removeFolder(applicationContext, id)
        }

        @JavascriptInterface
        fun retry(id: Int) {
            if (ok()) Sync.retry(applicationContext, id)
        }

        @JavascriptInterface
        fun setWifiOnly(on: Boolean) {
            if (ok()) Sync.setWifiOnly(applicationContext, on)
        }

        @JavascriptInterface
        fun syncNow() {
            if (ok()) SyncService.start(applicationContext)
        }
    }

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            page = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            page = url
        }

        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            val url = req.url.toString()
            if (ours(url)) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, req.url))
            } catch (e: ActivityNotFoundException) {
                toast("nothing can open $url")
            }
            return true
        }

        override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
            if (!req.isForMainFrame) return
            // shelf at home stopped answering: carry on through the public edge
            if (base == BuildConfig.LAN_URL) return use(BuildConfig.PUBLIC_URL)
            val url = req.url.toString()
            val html = "<body style='background:#17110c;color:#ddd2c4;font:16px sans-serif;padding:2em'>" +
                "<p>shelf cannot be reached: ${Html.escapeHtml(err.description)}</p>" +
                "<p><a style='color:#7bbf6a' href='${Html.escapeHtml(url)}'>try again</a></p>"
            view.loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
        }
    }

    private inner class Chrome : WebChromeClient() {
        private var full: View? = null
        private var done: CustomViewCallback? = null

        fun showing() = full != null

        override fun onShowFileChooser(
            view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
        ): Boolean {
            chooser?.onReceiveValue(null)
            chooser = callback
            val pick = params.createIntent()
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            return try {
                startActivityForResult(pick, PICK)
                true
            } catch (e: ActivityNotFoundException) {
                chooser = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (full != null) return callback.onCustomViewHidden()
            full = view
            done = callback
            (window.decorView as FrameLayout).addView(
                view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            bars(false)
        }

        override fun onHideCustomView() {
            val v = full ?: return
            (window.decorView as FrameLayout).removeView(v)
            full = null
            done?.onCustomViewHidden()
            done = null
            bars(true)
        }

        private fun bars(show: Boolean) {
            if (Build.VERSION.SDK_INT >= 30) {
                val c = window.insetsController ?: return
                if (show) {
                    c.show(WindowInsets.Type.systemBars())
                } else {
                    c.hide(WindowInsets.Type.systemBars())
                    c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = if (show) 0 else
                    View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            }
        }
    }
}
