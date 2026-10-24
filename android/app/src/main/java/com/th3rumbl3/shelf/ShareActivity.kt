package com.th3rumbl3.shelf

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.InputType
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** the mail app (mail-app repo); any other mail app when it is not installed */
private const val MAIL = "com.th3rumbl3.mail"
private const val FG = 0xffddd2c4.toInt()
private const val DIM = 0xff8c7f6d.toInt()
private const val PANEL = 0xff201810.toInt()
private const val BORDER = 0xff4a3c2d.toInt()
private const val DANGER = 0xffc0473b.toInt()

/**
 * "Share → shelf" from any app: the files go to a folder in the user's home
 * (one file as it is, several in a new folder named by the time) and get a
 * public link, which is copied or put in a new mail. It uses the app's login
 * cookie, at home or through the public edge like [MainActivity], so shelf
 * has to be signed in to in the app first.
 */
class ShareActivity : Activity() {
    private class Item(val uri: Uri?, val name: String, val size: Long, val text: String? = null)
    private class Link(val url: String, val what: String, val expires: Long?)

    private val main = Handler(Looper.getMainLooper())
    private lateinit var items: List<Item>
    private lateinit var folder: EditText
    private lateinit var days: EditText
    private lateinit var status: TextView
    private lateinit var bar: ProgressBar
    private lateinit var buttons: LinearLayout
    private lateinit var open: TextView
    @Volatile private var gone = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        items = items(intent)
        if (items.isEmpty()) {
            toast("nothing to put on shelf")
            return finish()
        }
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setContentView(layout())
    }

    override fun onDestroy() {
        gone = true
        super.onDestroy()
    }

    /** what was shared: files, or a text that becomes a .txt */
    private fun items(i: Intent): List<Item> {
        @Suppress("DEPRECATION")
        val uris = when (i.action) {
            Intent.ACTION_SEND -> listOfNotNull(i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> emptyList()
        }.ifEmpty { i.clipData?.let { c -> (0 until c.itemCount).mapNotNull { c.getItemAt(it).uri } }.orEmpty() }
        if (uris.isNotEmpty()) return uris.map { item(it) }
        val text = i.getStringExtra(Intent.EXTRA_TEXT) ?: return emptyList()
        val name = i.getStringExtra(Intent.EXTRA_SUBJECT)?.let { clean(it) }?.ifEmpty { null } ?: "text ${stamp()}"
        return listOf(Item(null, "$name.txt", text.toByteArray().size.toLong(), text))
    }

    private fun item(uri: Uri): Item {
        var name: String? = null
        var size = -1L
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst()) {
                    name = it.getString(0)
                    if (!it.isNull(1)) size = it.getLong(1)
                }
            }
        } catch (e: RuntimeException) {
            // a provider that cannot say; the name comes from the address
        }
        var n = clean(name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "").ifEmpty { "file" }
        if (!n.contains('.')) {
            contentResolver.getType(uri)?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }?.let { n += ".$it" }
        }
        return Item(uri, n, size)
    }

    /** a name shelf takes: no slashes or control characters */
    private fun clean(name: String) = name.map { if (it == '/' || it == '\\' || it.isISOControl()) '_' else it }
        .joinToString("").trim().trimStart('.')

    /** the folder and expiry used last */
    private fun prefs() = getSharedPreferences("share", MODE_PRIVATE)

    private fun stamp() = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())

    /* ---- the window ---- */

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, color: Int = FG, size: Float = 15f) = TextView(this).apply {
        text = s
        setTextColor(color)
        textSize = size
    }

    private fun box(fill: Int) = GradientDrawable().apply {
        setColor(fill)
        setStroke(dp(1), BORDER)
    }

    private fun field(value: String, hint: String, number: Boolean) = EditText(this).apply {
        setText(value)
        this.hint = hint
        setTextColor(FG)
        setHintTextColor(DIM)
        textSize = 15f
        setSingleLine()
        inputType = if (number) InputType.TYPE_CLASS_NUMBER else InputType.TYPE_CLASS_TEXT
        background = box(PANEL)
        setPadding(dp(8), dp(6), dp(8), dp(6))
    }

    private fun button(label: String, click: () -> Unit) = TextView(this).apply {
        text = label
        setTextColor(FG)
        textSize = 15f
        gravity = Gravity.CENTER
        background = box(PANEL)
        setPadding(dp(14), dp(10), dp(14), dp(10))
        setOnClickListener { click() }
    }

    private fun layout(): View {
        val p = prefs()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xff17110c.toInt())
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        fun add(v: View, top: Int = 8) = col.addView(v, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) })

        add(text("put on shelf and share", size = 18f).apply { setTypeface(typeface, Typeface.BOLD) }, 0)
        items.take(4).forEach { add(text(it.name + if (it.size >= 0) "  " + Formatter.formatShortFileSize(this, it.size) else "", DIM), 4) }
        if (items.size > 4) add(text("and ${items.size - 4} more", DIM), 4)
        add(text("folder in your home" + if (items.size > 1) " (the files go in a new folder there)" else "", DIM), 14)
        folder = field(p.getString("folder", null) ?: "Shared", "Shared", false)
        add(folder, 4)
        days = field(p.getString("days", null) ?: "", "never", true)
        add(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(text("link expires after ", DIM))
            addView(days, LinearLayout.LayoutParams(dp(80), ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(text(" days", DIM))
        }, 10)
        buttons = LinearLayout(this).apply {
            val lp = { LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(8) } }
            addView(button("copy link") { go(false) }, lp())
            addView(button("email") { go(true) }, lp())
            addView(button("cancel") { finish() }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        add(buttons, 16)
        bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            visibility = View.GONE
        }
        add(bar, 12)
        status = text("", DIM).apply { visibility = View.GONE }
        add(status, 6)
        open = button("open shelf to sign in") {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }.apply { visibility = View.GONE }
        add(open, 10)
        return col
    }

    private fun show(s: String, color: Int = DIM) {
        status.text = s
        status.setTextColor(color)
        status.visibility = View.VISIBLE
    }

    private fun busy(on: Boolean) {
        buttons.visibility = if (on) View.GONE else View.VISIBLE
        bar.visibility = if (on) View.VISIBLE else View.GONE
        folder.isEnabled = !on
        days.isEnabled = !on
        setFinishOnTouchOutside(!on)
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    /* ---- sending ---- */

    private class Failed(msg: String, val signIn: Boolean = false) : Exception(msg)

    private fun go(mail: Boolean) {
        val dir = folder.text.toString().split('/').map { clean(it) }.filter { it.isNotEmpty() }.joinToString("/")
            .ifEmpty { "Shared" }
        val d = days.text.toString().trim().toLongOrNull()?.takeIf { it > 0 }
        prefs().edit().putString("folder", dir).putString("days", d?.toString() ?: "").apply()
        // the login cookies are read here: CookieManager wants the main thread
        val cm = CookieManager.getInstance()
        val cookies = listOf(BuildConfig.LAN_URL, BuildConfig.PUBLIC_URL).associateWith { cm.getCookie(it) }
        busy(true)
        open.visibility = View.GONE
        show("connecting to shelf")
        Thread {
            try {
                val link = send(cookies, dir, d)
                main.post { if (!gone) done(link, mail) }
            } catch (e: Failed) {
                main.post { if (!gone) failed(e.message!!, e.signIn) }
            } catch (e: IOException) {
                main.post { if (!gone) failed("shelf cannot be reached: ${e.message ?: e.javaClass.simpleName}", false) }
            } catch (e: RuntimeException) {
                main.post { if (!gone) failed("${e.javaClass.simpleName}: ${e.message}", false) }
            }
        }.start()
    }

    private fun failed(msg: String, signIn: Boolean) {
        busy(false)
        show(msg, DANGER)
        if (signIn) open.visibility = View.VISIBLE
    }

    private fun done(link: Link, mail: Boolean) {
        if (!mail) {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("shelf link", link.url))
            // Android 13 and later show what was copied themselves
            if (Build.VERSION.SDK_INT < 33) toast("link copied")
            return finish()
        }
        val until = link.expires?.let { "\n\nThe link works until " + SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(Date(it * 1000)) + "." } ?: ""
        val to = Uri.parse("mailto:?subject=" + Uri.encode(link.what) + "&body=" + Uri.encode(link.url + until))
        val write = Intent(Intent.ACTION_SENDTO, to)
        try {
            startActivity(Intent(write).setPackage(MAIL))
        } catch (e: ActivityNotFoundException) {
            try {
                startActivity(write)
            } catch (e: ActivityNotFoundException) {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("shelf link", link.url))
                toast("no mail app here; the link is copied")
            }
        }
        finish()
    }

    /** puts the items into [dir] and makes the link; on a worker thread */
    private fun send(cookies: Map<String, String?>, dir: String, days: Long?): Link {
        val (base, cookie) = session(cookies)
        val single = items.size == 1
        val there = names(base, cookie, dir)
        val target: String
        val names: List<String>
        if (single) {
            target = "$dir/${free(items[0].name, there)}"
            names = listOf(target)
        } else {
            target = "$dir/${free(stamp(), there)}"
            val taken = HashSet<String>()
            names = items.map { "$target/${free(it.name, taken).also { n -> taken.add(n) }}" }
        }
        val total = items.sumOf { maxOf(it.size, 0L) }.coerceAtLeast(1)
        var sent = 0L
        items.forEachIndexed { i, it ->
            val what = if (single) "sending ${it.name}" else "sending ${i + 1} of ${items.size}: ${it.name}"
            main.post { if (!gone) show(what) }
            val src = it.text?.let { t -> ByteArrayInputStream(t.toByteArray()) }
                ?: try {
                    contentResolver.openInputStream(it.uri!!)
                } catch (e: FileNotFoundException) {
                    null
                } catch (e: SecurityException) {
                    null
                } ?: throw Failed("${it.name} cannot be read")
            val start = sent
            val r = src.use { s ->
                call("PUT", "$base/api/raw/home/${Sync.enc(names[i])}?mode=new&mkdirs=1", cookie, null, s, it.size) { n ->
                    sent = start + n
                    main.post { bar.progress = (sent * 1000 / total).toInt().coerceAtMost(1000) }
                }
            }
            if (r.code != 200) throw Failed("${it.name}: ${r.error()}")
        }
        main.post { if (!gone) show("making the link") }
        val body = JSONObject().put("loc", "home").put("path", target).put("days", days ?: JSONObject.NULL)
        val r = call("POST", "$base/api/links", cookie, body.toString())
        if (r.code != 200) throw Failed("the link: ${r.error()}")
        val url = JSONObject(r.body).getString("url")
        val what = if (single) items[0].name else "${items.size} files"
        return Link(if (url.startsWith("/")) base + url else url, what, days?.let { System.currentTimeMillis() / 1000 + it * 86400 })
    }

    /** shelf at home when it answers there with a login, else through the public edge */
    private fun session(cookies: Map<String, String?>): Pair<String, String> {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val local = caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        val bases = if (local) listOf(BuildConfig.LAN_URL, BuildConfig.PUBLIC_URL) else listOf(BuildConfig.PUBLIC_URL)
        var err: IOException? = null
        var answered = false
        for (b in bases.distinct()) {
            val cookie = cookies[b] ?: continue
            val r = try {
                call("GET", "$b/api/me", cookie, timeout = if (b == BuildConfig.LAN_URL) 2000 else 15000)
            } catch (e: IOException) {
                err = e
                continue
            }
            answered = true
            when (r.code) {
                200 -> return b to cookie
                // signed out there; perhaps signed in at the other address
                401 -> continue
                else -> throw Failed(r.error())
            }
        }
        if (err != null && !answered) throw err
        throw Failed("you are not signed in to shelf in this app", true)
    }

    /** names in [dir] in the home; none when it is not there yet */
    private fun names(base: String, cookie: String, dir: String): MutableSet<String> {
        val r = call("GET", "$base/api/ls/home/${Sync.enc(dir)}", cookie)
        return when (r.code) {
            200 -> {
                val o = JSONObject(r.body)
                val a = o.optJSONArray("entries") ?: throw Failed("$dir is a file on shelf, not a folder")
                (0 until a.length()).mapTo(HashSet()) { a.getJSONObject(it).getString("name") }
            }
            404 -> HashSet()
            else -> throw Failed(r.error())
        }
    }

    /** [name], or `name (2).ext` and so on when it is taken */
    private fun free(name: String, taken: Set<String>): String {
        if (name !in taken) return name
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        return (2..Int.MAX_VALUE).asSequence().map { "${name.substring(0, dot)} ($it)${name.substring(dot)}" }.first { it !in taken }
    }

    private fun call(method: String, url: String, cookie: String, json: String? = null, src: InputStream? = null,
                     len: Long = -1, timeout: Int = 30000, sent: ((Long) -> Unit)? = null): Sync.Reply {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = minOf(timeout, 10000)
            c.readTimeout = timeout
            c.instanceFollowRedirects = false
            c.setRequestProperty("Cookie", cookie)
            // shelf wants it on every change, like from its own pages
            c.setRequestProperty("X-Shelf", "1")
            c.setRequestProperty("User-Agent", "shelf-android/" + BuildConfig.VERSION_NAME)
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toByteArray()) }
            } else if (src != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/octet-stream")
                if (len >= 0) c.setFixedLengthStreamingMode(len) else c.setChunkedStreamingMode(64 * 1024)
                c.outputStream.use { out ->
                    val buf = ByteArray(64 * 1024)
                    var n = 0L
                    var last = 0L
                    while (true) {
                        val k = src.read(buf)
                        if (k < 0) break
                        out.write(buf, 0, k)
                        n += k
                        val now = System.currentTimeMillis()
                        if (now - last > 200) {
                            last = now
                            sent?.invoke(n)
                        }
                    }
                    sent?.invoke(n)
                }
            }
            val code = c.responseCode
            val body = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return Sync.Reply(code, body)
        } finally {
            c.disconnect()
        }
    }
}
