package com.th3rumbl3.shelf

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One-way sync of phone folders to shelf. Each folder, picked in Android's
 * folder picker, goes to a folder in the user's shelf home. A file is put again
 * when its size or time changes on the phone. shelf refuses to replace a file
 * somebody changed there since the phone put it (412), or one the phone did
 * not put (409); such a file waits until it changes on the phone again.
 * Nothing is ever removed, on either side.
 */
object Sync {
    const val JOB_HOURLY = 1
    const val JOB_MEDIA = 2
    private const val PREFS = "sync"
    private val busy = AtomicBoolean(false)
    @Volatile private var helper: State? = null

    /** the one connection to what the phone put where */
    private fun state(ctx: Context) = helper ?: synchronized(this) { helper ?: State(ctx).also { helper = it } }

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun paired(ctx: Context) = prefs(ctx).getString("token", null) != null
    fun running() = busy.get()

    class Folder(val id: Int, val uri: Uri, val name: String, var dest: String, var local: Int) {
        fun json() = JSONObject().put("id", id).put("uri", uri.toString()).put("name", name).put("dest", dest).put("local", local)
    }

    fun folders(ctx: Context): List<Folder> {
        val a = JSONArray(prefs(ctx).getString("folders", "[]"))
        return (0 until a.length()).map {
            val o = a.getJSONObject(it)
            Folder(o.getInt("id"), Uri.parse(o.getString("uri")), o.getString("name"), o.getString("dest"), o.optInt("local", -1))
        }
    }

    @Synchronized
    private fun saveFolders(ctx: Context, list: List<Folder>) {
        prefs(ctx).edit().putString("folders", JSONArray(list.map { it.json() }).toString()).apply()
    }

    @Synchronized
    fun addFolder(ctx: Context, uri: Uri): Folder {
        val list = folders(ctx)
        list.find { it.uri == uri }?.let { return it }
        val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
        val name = ctx.contentResolver.query(root, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: "phone"
        val f = Folder((list.maxOfOrNull { it.id } ?: 0) + 1, uri, name, "Phone/$name", -1)
        saveFolders(ctx, list + f)
        schedule(ctx)
        return f
    }

    @Synchronized
    fun setDest(ctx: Context, id: Int, dest: String) {
        val list = folders(ctx)
        val f = list.find { it.id == id } ?: return
        val d = clean(dest)
        if (d.isEmpty() || d == f.dest) return
        f.dest = d
        saveFolders(ctx, list)
        // what was put into the old folder says nothing about the new one
        state(ctx).forget(id, false)
    }

    @Synchronized
    fun removeFolder(ctx: Context, id: Int) {
        val list = folders(ctx)
        val f = list.find { it.id == id } ?: return
        try {
            ctx.contentResolver.releasePersistableUriPermission(f.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: SecurityException) {
        }
        saveFolders(ctx, list - f)
        state(ctx).forget(id, false)
        schedule(ctx)
    }

    /** the files shelf refused are tried again on the next run */
    fun retry(ctx: Context, id: Int) = state(ctx).forget(id, true)

    fun pair(ctx: Context, token: String, username: String, device: String, id: Long) {
        state(ctx).forget(null, false)
        prefs(ctx).edit().putString("token", token).putString("username", username).putString("device", device)
            .putLong("device_id", id).remove("status").apply()
        schedule(ctx)
    }

    /** forgets the token; tells shelf too when [tell] */
    fun unpair(ctx: Context, tell: Boolean) {
        val token = prefs(ctx).getString("token", null) ?: return
        prefs(ctx).edit().remove("token").remove("device_id").apply()
        state(ctx).forget(null, false)
        schedule(ctx)
        if (tell) Thread {
            for (b in listOf(BuildConfig.LAN_URL, BuildConfig.PUBLIC_URL)) try {
                if (call("DELETE", "$b/api/sync/me", token, 5000).code < 500) break
            } catch (e: IOException) {
            }
        }.start()
    }

    fun setWifiOnly(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean("wifi_only", on).apply()
        schedule(ctx)
    }

    private fun clean(dest: String) = dest.split('/').map { it.trim() }.filter { it.isNotEmpty() && it != "." && it != ".." }
        .joinToString("/")

    /* ---- the jobs: every hour, and soon after new pictures or videos ---- */

    private fun net(ctx: Context) =
        if (prefs(ctx).getBoolean("wifi_only", true)) JobInfo.NETWORK_TYPE_UNMETERED else JobInfo.NETWORK_TYPE_ANY

    /** (re)plans both jobs after a change of the settings */
    fun schedule(ctx: Context) {
        val js = ctx.getSystemService(JobScheduler::class.java)
        if (!paired(ctx) || folders(ctx).isEmpty()) return js.cancelAll()
        js.schedule(
            JobInfo.Builder(JOB_HOURLY, ComponentName(ctx, SyncJob::class.java))
                .setPeriodic(3600_000L)
                .setRequiredNetworkType(net(ctx))
                .setPersisted(true)
                .build(),
        )
        media(ctx, true)
    }

    /** plans the jobs that are missing, after a reboot or an update */
    fun ensure(ctx: Context) {
        val js = ctx.getSystemService(JobScheduler::class.java)
        if (js.getPendingJob(JOB_HOURLY) == null) schedule(ctx) else media(ctx, false)
    }

    /** a job waiting for new media; it runs once, so each run plans the next one */
    fun media(ctx: Context, again: Boolean) {
        val js = ctx.getSystemService(JobScheduler::class.java)
        if (!paired(ctx) || folders(ctx).isEmpty()) return
        if (!again && js.getPendingJob(JOB_MEDIA) != null) return
        val flag = JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS
        js.schedule(
            JobInfo.Builder(JOB_MEDIA, ComponentName(ctx, SyncJob::class.java))
                .addTriggerContentUri(JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, flag))
                .addTriggerContentUri(JobInfo.TriggerContentUri(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, flag))
                .setTriggerContentUpdateDelay(15_000L)
                .setTriggerContentMaxDelay(120_000L)
                .setRequiredNetworkType(net(ctx))
                .build(),
        )
    }

    /* ---- a run ---- */

    class Failed(msg: String) : Exception(msg)
    class Stopped : Exception("stopped")

    private class Local(val uri: Uri, val path: String, val size: Long, val mtime: Long)

    /**
     * Puts what changed in all the folders. Returns false when another run is
     * going on. [show] gets the progress: done, total and what is being done.
     */
    fun run(ctx: Context, stop: () -> Boolean, show: (Int, Int, String) -> Unit): Boolean {
        if (!busy.compareAndSet(false, true)) return false
        val st = Status(ctx)
        try {
            st.start()
            val token = prefs(ctx).getString("token", null) ?: throw Failed("this phone is not paired")
            val base = base(ctx, token)
            val db = state(ctx)
            val dirs = HashMap<String, Map<String, JSONObject>>()
            for (f in folders(ctx)) {
                if (stop()) throw Stopped()
                st.text("looking through ${f.name}")
                show(0, 0, "looking through ${f.name}")
                val files = ArrayList<Local>()
                try {
                    val tree = DocumentsContract.getTreeDocumentId(f.uri)
                    walk(ctx, f.uri, tree, "", files, stop)
                } catch (e: SecurityException) {
                    st.problem("${f.name} cannot be read any more; remove it and add it again")
                    continue
                }
                synchronized(this) {
                    val list = folders(ctx)
                    list.find { it.id == f.id }?.let { it.local = files.size; saveFolders(ctx, list) }
                }
                val known = db.rows(f.id)
                val todo = files.filter { l -> known[l.path].let { it == null || it.size != l.size || it.mtime != l.mtime } }
                var fails = 0
                todo.forEachIndexed { i, l ->
                    if (stop()) throw Stopped()
                    val what = "${f.name}: ${i + 1} of ${todo.size}, ${l.path}"
                    st.text(what)
                    show(i, todo.size, what)
                    try {
                        if (put(ctx, base, token, db, dirs, f, l, known[l.path])) st.sent()
                        fails = 0
                    } catch (e: FileNotFoundException) {
                        // gone since the walk
                    } catch (e: IOException) {
                        // one unreadable file should not end the run, a lost network should
                        if (++fails >= 3) throw Failed("sending failed: ${e.message ?: e.javaClass.simpleName}")
                    }
                }
            }
            st.finish(null)
        } catch (e: Stopped) {
            st.finish("stopped; the rest goes next time")
        } catch (e: Failed) {
            st.finish(e.message)
        } catch (e: IOException) {
            st.finish("shelf cannot be reached: ${e.message ?: e.javaClass.simpleName}")
        } catch (e: RuntimeException) {
            st.finish("${e.javaClass.simpleName}: ${e.message}")
        } finally {
            busy.set(false)
        }
        return true
    }

    /** shelf at home when it answers there, else the public address; checks the token too */
    private fun base(ctx: Context, token: String): String {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val local = caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        val bases = if (local) listOf(BuildConfig.LAN_URL, BuildConfig.PUBLIC_URL) else listOf(BuildConfig.PUBLIC_URL)
        var err: IOException? = null
        for (b in bases) {
            val r = try {
                call("GET", "$b/api/sync/me", token, if (b == BuildConfig.LAN_URL) 2000 else 15000)
            } catch (e: IOException) {
                err = e
                continue
            }
            when (r.code) {
                200 -> return b
                401 -> {
                    unpair(ctx, false)
                    throw Failed("this phone was removed on shelf; pair it again")
                }
                else -> throw Failed(r.error())
            }
        }
        throw err ?: IOException("no network")
    }

    private fun walk(ctx: Context, tree: Uri, doc: String, rel: String, out: MutableList<Local>, stop: () -> Boolean) {
        if (stop()) throw Stopped()
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
        val dirs = ArrayList<Pair<String, String>>()
        ctx.contentResolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, doc), cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(1) ?: continue
                // hidden files, and what the gallery keeps in the trash or is still writing
                if (name.startsWith(".")) continue
                if (c.getString(2) == Document.MIME_TYPE_DIR) dirs.add(c.getString(0) to "$rel$name/")
                else out.add(Local(DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)), rel + name,
                    c.getLong(3), c.getLong(4) / 1000))
            }
        }
        for ((d, r) in dirs) walk(ctx, tree, d, r, out, stop)
    }

    fun enc(path: String) = path.split('/').filter { it.isNotEmpty() }.joinToString("/") { Uri.encode(it) }

    /** a folder on shelf by name, from a cache for the run; empty when it is not there */
    private fun ls(base: String, token: String, dirs: HashMap<String, Map<String, JSONObject>>, dir: String) =
        dirs.getOrPut(dir) {
            val r = call("GET", "$base/api/sync/ls/${enc(dir)}", token, 30000)
            when (r.code) {
                200 -> JSONObject(r.body).getJSONArray("entries").let { a ->
                    (0 until a.length()).map { a.getJSONObject(it) }.associateBy { it.getString("name") }
                }
                404 -> emptyMap()
                else -> throw Failed(r.error())
            }
        }

    /** whether the file was sent; else it was there already, or refused */
    private fun put(ctx: Context, base: String, token: String, db: State, dirs: HashMap<String, Map<String, JSONObject>>,
                    f: Folder, l: Local, was: State.Row?): Boolean {
        val path = "${f.dest}/${l.path}"
        // the etag of what this phone put there last; a refused file is only tried as new
        val tag = was?.takeIf { it.why == null }?.etag
        // shelf answers a refusal before it reads the file, which breaks off a big upload:
        // what it would refuse is found out from the folder first
        val there = ls(base, token, dirs, path.substringBeforeLast('/'))[path.substringAfterLast('/')]
        if (tag == null && there != null) {
            // the same file is there already (sent before pairing, or by hand): take it as sent
            val same = !there.optBoolean("dir") && there.optLong("size") == l.size
            db.put(f.id, l, null, if (same) null else "another file of that name is on shelf")
            return false
        }
        if (tag != null && there?.optString("etag") != tag) {
            db.put(f.id, l, tag, "changed or removed on shelf since this phone put it there")
            return false
        }
        val r = ctx.contentResolver.openInputStream(l.uri)?.use { src ->
            call("PUT", "$base/api/sync/put/${enc(path)}?mtime=${l.mtime}", token, 30000, tag, l.size, src)
        } ?: throw FileNotFoundException(l.path)
        when (r.code) {
            200 -> {
                db.put(f.id, l, JSONObject(r.body).optString("etag"), null)
                return true
            }
            409 -> db.put(f.id, l, null, "another file of that name is on shelf")
            412 -> db.put(f.id, l, was?.etag, "changed or removed on shelf since this phone put it there")
            401 -> {
                unpair(ctx, false)
                throw Failed("this phone was removed on shelf; pair it again")
            }
            // a name shelf does not take, or a file too big for the way in
            400, 413, 415 -> db.put(f.id, l, null, r.error())
            else -> throw Failed(r.error())
        }
        return false
    }

    class Reply(val code: Int, val body: String) {
        fun error() = try {
            JSONObject(body).getString("error")
        } catch (e: org.json.JSONException) {
            "shelf answered $code"
        }
    }

    private fun call(method: String, url: String, token: String, timeout: Int, ifMatch: String? = null,
                     len: Long = -1, src: InputStream? = null): Reply {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = minOf(timeout, 10000)
            c.readTimeout = timeout
            c.instanceFollowRedirects = false
            c.setRequestProperty("Authorization", "Bearer $token")
            // shelf wants it on every change, like from its own pages
            c.setRequestProperty("X-Shelf", "1")
            c.setRequestProperty("User-Agent", "shelf-android/" + BuildConfig.VERSION_NAME)
            if (ifMatch != null) c.setRequestProperty("If-Match", ifMatch)
            if (src != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/octet-stream")
                c.setFixedLengthStreamingMode(len)
                c.outputStream.use { src.copyTo(it, 64 * 1024) }
            }
            val code = c.responseCode
            val body = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return Reply(code, body)
        } finally {
            c.disconnect()
        }
    }

    /* ---- what the phone put where ---- */

    private class State(ctx: Context) : SQLiteOpenHelper(ctx.applicationContext, "sync.db", null, 1) {
        class Row(val size: Long, val mtime: Long, val etag: String?, val why: String?)

        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE files (folder INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, " +
                    "mtime INTEGER NOT NULL, etag TEXT, why TEXT, PRIMARY KEY (folder, path))",
            )
        }

        override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {}

        fun rows(folder: Int): Map<String, Row> {
            val m = HashMap<String, Row>()
            readableDatabase.rawQuery("SELECT path, size, mtime, etag, why FROM files WHERE folder = ?", arrayOf("$folder")).use {
                while (it.moveToNext()) m[it.getString(0)] = Row(it.getLong(1), it.getLong(2), it.getString(3), it.getString(4))
            }
            return m
        }

        fun put(folder: Int, l: Local, etag: String?, why: String?) {
            writableDatabase.insertWithOnConflict("files", null, ContentValues().apply {
                put("folder", folder)
                put("path", l.path)
                put("size", l.size)
                put("mtime", l.mtime)
                put("etag", etag)
                put("why", why)
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }

        /** a folder's rows (or all), or only the refused ones */
        fun forget(folder: Int?, refused: Boolean) {
            val w = listOfNotNull(folder?.let { "folder = $it" }, if (refused) "why IS NOT NULL" else null)
            writableDatabase.delete("files", w.joinToString(" AND ").ifEmpty { null }, null)
        }

        /** per folder: files sent, files refused and the first refused ones */
        fun counts(folder: Int): JSONObject {
            val o = JSONObject()
            readableDatabase.rawQuery(
                "SELECT COUNT(*) - COUNT(why), COUNT(why) FROM files WHERE folder = ?", arrayOf("$folder"),
            ).use { if (it.moveToFirst()) o.put("sent", it.getInt(0)).put("refused", it.getInt(1)) }
            val a = JSONArray()
            readableDatabase.rawQuery(
                "SELECT path, why FROM files WHERE folder = ? AND why IS NOT NULL ORDER BY path LIMIT 20", arrayOf("$folder"),
            ).use { while (it.moveToNext()) a.put(JSONObject().put("path", it.getString(0)).put("why", it.getString(1))) }
            return o.put("problems", a)
        }
    }

    /* ---- how the last run went, for the settings page and the notification ---- */

    private class Status(val ctx: Context) {
        private var sent = 0
        private var problems = ArrayList<String>()
        private var last = 0L

        fun start() = save(JSONObject().put("running", true).put("started", System.currentTimeMillis()).put("text", "starting"))

        fun text(t: String) {
            val now = System.currentTimeMillis()
            if (now - last < 500) return
            last = now
            save(JSONObject().put("running", true).put("text", t).put("sent", sent))
        }

        fun sent() {
            sent++
        }

        fun problem(p: String) {
            problems.add(p)
        }

        fun finish(err: String?) {
            val e = (listOfNotNull(err) + problems).joinToString("; ").ifEmpty { null }
            save(JSONObject().put("running", false).put("finished", System.currentTimeMillis()).put("sent", sent).put("error", e))
        }

        private fun save(o: JSONObject) = prefs(ctx).edit().putString("status", o.toString()).apply()
    }

    /** everything the settings page shows, as JSON */
    fun info(ctx: Context): String {
        val p = prefs(ctx)
        val db = state(ctx)
        val folders = JSONArray(folders(ctx).map { f ->
            val c = db.counts(f.id)
            JSONObject().put("id", f.id).put("name", f.name).put("dest", f.dest).put("local", f.local)
                .put("sent", c.optInt("sent")).put("refused", c.optInt("refused")).put("problems", c.getJSONArray("problems"))
        })
        return JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("model", Build.MODEL)
            .put("paired", paired(ctx))
            .put("username", p.getString("username", null))
            .put("device", p.getString("device", null))
            .put("device_id", p.getLong("device_id", 0))
            .put("wifi_only", p.getBoolean("wifi_only", true))
            .put("folders", folders)
            .put("status", p.getString("status", null)?.let { JSONObject(it) } ?: JSONObject())
            .put("running", running())
            .toString()
    }
}
