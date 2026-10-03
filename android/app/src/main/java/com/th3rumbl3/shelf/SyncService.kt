package com.th3rumbl3.shelf

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

private const val NOTE = 1
private const val STOP = "stop"

/**
 * "sync now": a run in the foreground, so a first sync of a big folder is not
 * cut short. It shows its progress, and can be stopped, in a notification.
 */
class SyncService : Service() {
    @Volatile private var stopping = false
    private var started = false

    companion object {
        fun start(ctx: Context) = ctx.startForegroundService(Intent(ctx, SyncService::class.java))
    }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        if (i?.action == STOP) {
            stopping = true
            if (!started) stopSelf()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("sync", "sync", NotificationManager.IMPORTANCE_LOW))
        startForeground(NOTE, note(0, 0, "starting"), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (started) return START_NOT_STICKY
        started = true
        Thread {
            var last = 0L
            Sync.run(applicationContext, { stopping }) { done, total, what ->
                val now = System.currentTimeMillis()
                if (now - last > 1000) {
                    last = now
                    nm.notify(NOTE, note(done, total, what))
                }
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }.start()
        return START_NOT_STICKY
    }

    private fun note(done: Int, total: Int, what: String): Notification {
        val stop = PendingIntent.getService(this, 0, Intent(this, SyncService::class.java).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "sync")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("shelf sync")
            .setContentText(what)
            .setProgress(total, done, total == 0)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "stop", stop).build())
            .build()
    }
}
