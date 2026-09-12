package com.onetake.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground worker for long-running local video exports. The job record is
 * persisted before this service starts, so a process death is reported as
 * interrupted when the next module instance opens the store.
 */
internal class MediaExportService : Service() {
  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private lateinit var store: MediaExportStore
  private val jobs = ConcurrentHashMap<String, Job>()
  private var lastStartId = 0

  override fun onCreate() {
    super.onCreate()
    store = MediaExportStore(applicationContext)
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    val id = intent?.getStringExtra(EXTRA_EXPORT_ID) ?: run {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }
    val initialNotification = notification(0)
    try {
      if (Build.VERSION.SDK_INT >= 35) {
        startForeground(
          NOTIFICATION_ID,
          initialNotification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING,
        )
      } else if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, initialNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, initialNotification)
      }
    } catch (failure: Throwable) {
      store.markFailed(id, failure.message ?: "Could not enter foreground mode")
      stopSelfResult(startId)
      return START_NOT_STICKY
    }
    if (jobs.containsKey(id)) return START_NOT_STICKY

    // Register the handle before starting the coroutine. A queued job can
    // finish immediately (for example after a duplicate or cancellation),
    // and eager launch could otherwise leave a stale entry in jobs.
    val job = serviceScope.launch(start = CoroutineStart.LAZY) {
      runExport(id)
    }
    jobs[id] = job
    job.invokeOnCompletion {
      jobs.remove(id, job)
      if (jobs.isEmpty()) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelfResult(lastStartId)
      }
    }
    job.start()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    jobs.values.forEach { it.cancel() }
    serviceScope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int) {
    interruptTimedOutExports(startId)
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    interruptTimedOutExports(startId)
  }

  private fun interruptTimedOutExports(startId: Int) {
    // Android 15+ calls this for mediaProcessing services that exceed the
    // platform budget. Mark active work interrupted before stopping.
    jobs.keys.forEach { id ->
      store.markInterrupted(id, "Android stopped the media export after its time limit.")
      MediaExportRuntime.cancel(id)
    }
    stopSelfResult(startId)
  }

  private suspend fun runExport(id: String) {
    val persisted = store.get(id) ?: return
    if (persisted.status != MediaExportStatus.QUEUED) return
    MediaExportRuntime.markActive(id)
    if (!store.markRunning(id)) {
      MediaExportRuntime.markInactive(id)
      return
    }

    updateNotification(0)
    try {
      val running = store.get(id) ?: return
      val output = store.outputFile(id)
      val runner = MediaExportRunner(applicationContext, store)
      runner.run(running, output) { progress ->
        store.updateProgress(id, progress)
        updateNotification(progress)
      }
      if (store.markCompleted(id, output.toURI().toString())) {
        updateNotification(100)
      } else {
        // Cancellation or timeout may have changed the persisted state while
        // Transformer was finishing. Do not retain an unassociated output.
        output.delete()
      }
    } catch (_: CancellationException) {
      // cancelExport already persisted the cancelled state. If cancellation
      // came from service teardown, leave the running state for recovery.
      if (store.get(id)?.status == MediaExportStatus.RUNNING) {
        store.markInterrupted(id, "Export stopped before it finished. Retry to start it again.")
      }
    } catch (failure: Throwable) {
      if (store.get(id)?.status != MediaExportStatus.CANCELLED) {
        store.markFailed(id, failure.message ?: failure::class.java.simpleName)
      }
    } finally {
      MediaExportRuntime.markInactive(id)
    }
  }

  private fun updateNotification(progress: Int) {
    val notificationManager = getSystemService(NotificationManager::class.java)
    notificationManager?.notify(NOTIFICATION_ID, notification(progress))
  }

  private fun notification(progress: Int): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("One Take export")
      .setContentText(if (progress >= 100) "Export complete" else "Creating captioned video")
      .setProgress(100, progress.coerceIn(0, 100), false)
      .setOngoing(progress < 100)
      .setOnlyAlertOnce(true)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(
      NotificationChannel(
        NOTIFICATION_CHANNEL_ID,
        "Video exports",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Progress for One Take captioned video exports"
      },
    )
  }

  companion object {
    const val ACTION_START = "com.onetake.media.START_EXPORT"
    const val EXTRA_EXPORT_ID = "com.onetake.media.EXPORT_ID"
    private const val NOTIFICATION_CHANNEL_ID = "one_take_exports"
    private const val NOTIFICATION_ID = 0x4f4e45
  }
}
