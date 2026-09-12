package expo.modules.onetakemediaresearch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import org.json.JSONObject
import java.io.File

object Jobs {
  val processId = java.util.UUID.randomUUID().toString()
  fun directory(context: Context) = File(context.filesDir, "one-take-export-jobs").apply { mkdirs() }
  fun outputDirectory(context: Context) = File(context.filesDir, "one-take-exports").apply { mkdirs() }
  fun file(context: Context, id: String): File {
    require(id.matches(Regex("[a-zA-Z0-9-]{1,80}")))
    return File(directory(context), "$id.json")
  }
  @Synchronized fun read(context: Context, id: String): JSONObject = JSONObject(file(context, id).readText())
  @Synchronized fun write(context: Context, job: JSONObject) {
    val destination = file(context, job.getString("id"))
    val pending = File(destination.path + ".tmp")
    pending.writeText(job.toString())
    check(pending.renameTo(destination)) { "Could not save export progress." }
  }
  fun blocked(context: Context, projectId: String) = context.getSharedPreferences("one-take-deleted-projects", 0).getBoolean(projectId, false)
}

@UnstableApi
class ExportService : Service() {
  companion object { var active: ExportService? = null }
  private val handler = Handler(Looper.getMainLooper())
  private var transformer: Transformer? = null
  var jobId: String? = null
    private set
  private var lastProgress = -1
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra("jobId") ?: return START_NOT_STICKY
    val job = try { Jobs.read(this, id) } catch (_: Exception) {
      // Project deletion may remove queued work before Android delivers its start intent.
      if (jobId == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (job.optString("state") != "queued" || Jobs.blocked(this, job.getString("projectId"))) {
      if (jobId == null) stopSelf()
      return START_NOT_STICKY
    }
    if (jobId != null) {
      Jobs.write(this, job.put("state", "failed").put("error", "Another video is exporting. Wait for it to finish, then retry."))
      return START_NOT_STICKY
    }
    active = this; jobId = id
    try {
      val manager = getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("one-take-export", "Video exports", NotificationManager.IMPORTANCE_LOW))
      val notificationBuilder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "one-take-export") else Notification.Builder(this)
      val notification = notificationBuilder.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("Exporting your video").setContentText("Your original recording is preserved.").setOngoing(true).build()
      if (Build.VERSION.SDK_INT >= 35) startForeground(901, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
      else if (Build.VERSION.SDK_INT >= 29) startForeground(901, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else startForeground(901, notification)
      val composition = CompositionFactory.build(job.getJSONArray("segments"))
      val output = File(Jobs.outputDirectory(this), "$id.mp4")
      require(output.parentFile!!.usableSpace > 64L * 1024 * 1024) { "Free up space before exporting. Your recording is safe." }
      val temp = File(Jobs.outputDirectory(this), "$id.partial.mp4")
      if (temp.exists()) check(temp.delete())
      Jobs.write(this, job.put("state", "running").put("progress", 0).put("uri", android.net.Uri.fromFile(output).toString()))
      transformer = Transformer.Builder(this).setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
        .addListener(object : Transformer.Listener {
          override fun onCompleted(composition: Composition, result: ExportResult) {
            try {
              check(temp.isFile && temp.length() > 0 && temp.renameTo(output)) { "Could not finish saving the export." }
              Jobs.write(this@ExportService, Jobs.read(this@ExportService, id).put("state", "completed").put("progress", 100).put("durationMs", result.durationMs).put("size", output.length()))
              finish()
            } catch (error: Exception) { fail(error.message ?: "Could not save the export.") }
          }
          override fun onError(composition: Composition, result: ExportResult, exception: ExportException) { fail("Export could not finish. Check free space and retry; your original is safe.") }
        }).build()
      transformer!!.start(composition, temp.path)
      handler.post(object : Runnable {
        override fun run() {
          val current = transformer ?: return
          val progress = ProgressHolder()
          if (current.getProgress(progress) == Transformer.PROGRESS_STATE_AVAILABLE && progress.progress != lastProgress) {
            lastProgress = progress.progress
            try { Jobs.write(this@ExportService, Jobs.read(this@ExportService, id).put("progress", progress.progress)) } catch (_: Exception) { fail("Could not save export progress. Free up space and retry."); return }
          }
          handler.postDelayed(this, 400)
        }
      })
    } catch (error: Exception) { fail(error.message ?: "Could not start export.") }
    return START_NOT_STICKY
  }

  fun cancel() {
    val id = jobId ?: return
    try {
      transformer?.cancel(); transformer = null
      File(Jobs.outputDirectory(this), "$id.partial.mp4").delete()
      Jobs.write(this, Jobs.read(this, id).put("state", "cancelled"))
    } finally { finish() }
  }
  private fun fail(message: String) {
    val id = jobId ?: return
    transformer?.cancel(); transformer = null
    File(Jobs.outputDirectory(this), "$id.partial.mp4").delete()
    try { Jobs.write(this, Jobs.read(this, id).put("state", "failed").put("error", message)) } finally { finish() }
  }
  private fun finish() {
    handler.removeCallbacksAndMessages(null); transformer = null; jobId = null; active = null
    stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
  }
  override fun onTimeout(startId: Int, fgsType: Int) { fail("Android stopped this export. Reopen the project to retry.") }
  override fun onDestroy() {
    if (jobId != null) fail("Export was interrupted. Reopen the project to retry.")
    super.onDestroy()
  }
}
