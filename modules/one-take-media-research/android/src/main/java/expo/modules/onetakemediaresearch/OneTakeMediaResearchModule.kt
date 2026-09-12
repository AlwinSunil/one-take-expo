package expo.modules.onetakemediaresearch

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

@UnstableApi
class OneTakeMediaResearchModule : Module() {
  private val context get() = appContext.reactContext ?: error("App is unavailable.")
  override fun definition() = ModuleDefinition {
    Name("OneTakeMediaResearch")
    AsyncFunction("inspectSource") { uri: String -> MediaInspection.inspect(uri) }
    AsyncFunction("inspectExport") { id: String ->
      val job = Jobs.read(context, id)
      check(job.optString("state") == "completed") { "Wait for the export to finish." }
      MediaInspection.inspect(job.getString("uri"))
    }
    AsyncFunction("startExport") { projectId: String, segments: String ->
      check(!Jobs.blocked(context, projectId)) { "This project is being deleted." }
      check(ExportService.active == null) { "Another video is exporting. Wait for it to finish." }
      val array = JSONArray(segments)
      CompositionFactory.build(array)
      val id = UUID.randomUUID().toString()
      val job = JSONObject().put("id", id).put("projectId", projectId).put("segments", array).put("state", "queued").put("progress", 0).put("processId", Jobs.processId)
      Jobs.write(context, job)
      try {
        val intent = Intent(context, ExportService::class.java).putExtra("jobId", id)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      } catch (error: Exception) {
        Jobs.write(context, job.put("state", "failed").put("error", "Android could not start the export. Return to the app and retry."))
      }
      id
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getJobs") { projectId: String ->
      val jobs = JSONArray()
      Jobs.directory(context).listFiles()?.filter { it.extension == "json" }?.forEach { file ->
        val job = JSONObject(file.readText())
        if (job.optString("projectId") == projectId) {
          // Queued work can also be stranded if Android kills us before the service starts.
          val state = job.optString("state")
          if ((state in listOf("queued", "running") && job.optString("processId") != Jobs.processId) ||
            (state == "running" && ExportService.active?.jobId != job.getString("id"))) {
            job.put("state", "interrupted").put("error", "Export was interrupted. Retry to create a complete video.")
            File(Jobs.outputDirectory(context), "${job.getString("id")}.partial.mp4").delete()
            Jobs.write(context, job)
          }
          // A successful export is usable only while the actual file is still present.
          if (job.optString("state") == "completed" && !File(Uri.parse(job.getString("uri")).path!!).isFile) {
            job.put("state", "failed").put("error", "The exported file is missing. Export again from your original.")
            Jobs.write(context, job)
          }
          jobs.put(job)
        }
      }
      jobs.toString()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelExport") { id: String ->
      if (ExportService.active?.jobId == id) ExportService.active?.cancel()
      else {
        val job = Jobs.read(context, id)
        if (job.optString("state") in listOf("queued", "running", "interrupted")) Jobs.write(context, job.put("state", "cancelled"))
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("deleteProjectExports") { projectId: String ->
      synchronized(Jobs) {
        context.getSharedPreferences("one-take-deleted-projects", 0).edit().putBoolean(projectId, true).commit()
      }
      Jobs.directory(context).listFiles()?.filter { it.extension == "json" }?.forEach { file ->
        val job = JSONObject(file.readText())
        if (job.optString("projectId") == projectId) {
          val id = job.getString("id")
          if (ExportService.active?.jobId == id) ExportService.active?.cancel()
          Jobs.write(context, job.put("state", "cancelled"))
          val gallery = job.optString("galleryUri")
          if (gallery.isNotEmpty()) context.contentResolver.delete(Uri.parse(gallery), null, null)
          for (name in listOf("$id.mp4", "$id.partial.mp4")) {
            val media = File(Jobs.outputDirectory(context), name)
            check(!media.exists() || media.delete()) { "Some export files could not be removed. Try deleting again." }
          }
          check(file.delete()) { "Could not clear export history. Try deleting again." }
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("saveToGallery") { id: String ->
      check(Build.VERSION.SDK_INT >= 29) { "Gallery saving requires Android 10 or newer. Use Share to save this video." }
      val job = Jobs.read(context, id)
      check(job.optString("state") == "completed") { "Wait for the export to finish." }
      check(!Jobs.blocked(context, job.getString("projectId"))) { "This project is being deleted." }
      val savedUri = job.optString("galleryUri")
      if (savedUri.isNotEmpty()) {
        val stillExists = try {
          context.contentResolver.openAssetFileDescriptor(Uri.parse(savedUri), "r")?.use { true } ?: false
        } catch (_: java.io.FileNotFoundException) { false } catch (_: SecurityException) { false }
        if (stillExists) return@AsyncFunction savedUri
        job.remove("galleryUri")
      }
      val source = File(Uri.parse(job.getString("uri")).path!!)
      check(source.isFile) { "Exported video is missing. Export again." }
      val values = ContentValues().apply {
        put(MediaStore.Video.Media.DISPLAY_NAME, "One-Take-$id.mp4")
        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
        put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/One Take")
        put(MediaStore.Video.Media.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: error("Could not create a gallery video.")
      try {
        resolver.openOutputStream(uri)?.use { output -> source.inputStream().use { it.copyTo(output) } } ?: error("Could not open gallery storage.")
        synchronized(Jobs) {
          // A deletion during the copy must not publish an orphaned gallery video.
          check(!Jobs.blocked(context, job.getString("projectId"))) { "This project is being deleted." }
          resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
          Jobs.write(context, job.put("galleryUri", uri.toString()))
        }
        uri.toString()
      } catch (error: Exception) { resolver.delete(uri, null, null); throw error }
    }

    AsyncFunction("shareExport") { id: String ->
      val job = Jobs.read(context, id)
      check(job.optString("state") == "completed") { "Wait for the export to finish." }
      val file = File(Uri.parse(job.getString("uri")).path!!)
      check(file.isFile) { "The exported file is missing. Export again." }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.onetake.media.research", file)
      val intent = Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      val activity = appContext.currentActivity ?: error("Return to the app before sharing.")
      activity.startActivity(Intent.createChooser(intent, "Share video"))
    }.runOnQueue(Queues.MAIN)

    View(CutPreviewView::class) {
      Events("onState")
      Prop("segments") { view: CutPreviewView, segments: String -> view.setSegments(segments) }
      Prop("playing") { view: CutPreviewView, playing: Boolean -> view.setPlaying(playing) }
      Prop("seek") { view: CutPreviewView, value: Double -> view.seek(value) }
    }
  }
}
