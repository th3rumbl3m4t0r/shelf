package com.th3rumbl3.shelf

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.ConcurrentHashMap

/** Runs a sync for the hourly job and for the one waiting for new media. */
class SyncJob : JobService() {
    private val stop = ConcurrentHashMap<Int, Boolean>()

    override fun onStartJob(p: JobParameters): Boolean {
        stop[p.jobId] = false
        Thread {
            Sync.run(applicationContext, { stop[p.jobId] == true }) { _, _, _ -> }
            // the media job runs once; the hourly one brings it back after a reboot
            Sync.media(applicationContext, p.jobId == Sync.JOB_MEDIA)
            jobFinished(p, false)
        }.start()
        return true
    }

    override fun onStopJob(p: JobParameters): Boolean {
        stop[p.jobId] = true
        return p.jobId == Sync.JOB_MEDIA
    }
}
