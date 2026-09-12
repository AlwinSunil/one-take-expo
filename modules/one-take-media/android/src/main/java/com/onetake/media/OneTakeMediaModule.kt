package com.onetake.media

import android.content.Intent
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Expo bridge for app-private Media3 captioned video exports. */
class OneTakeMediaModule : Module() {
  private var store: MediaExportStore? = null

  override fun definition() = ModuleDefinition {
    Name("OneTakeMedia")

    OnCreate {
      store = MediaExportStore(applicationContext())
      store?.markInterruptedRunningJobs()
    }

    AsyncFunction("startExport") Coroutine { request: Map<String, Any?> ->
      val exportStore = requireStore()
      // Request validation and the durable queue write both touch disk. Keep
      // them off Expo's single async-function handler thread so status polls
      // and unrelated native module calls remain responsive.
      val job = withContext(Dispatchers.IO) {
        val parsed = MediaExportRequestParser.parse(request)
        exportStore.enqueue(parsed)
      }
      if (job.status == MediaExportStatus.QUEUED) {
        val context = applicationContext()
        val intent = Intent(context, MediaExportService::class.java)
          .setAction(MediaExportService.ACTION_START)
          .putExtra(MediaExportService.EXTRA_EXPORT_ID, job.request.id)
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, intent)
          } else {
            context.startService(intent)
          }
        } catch (failure: Throwable) {
          exportStore.markFailed(job.request.id, failure.message ?: "Could not start export service")
          throw IllegalStateException("Could not start background export", failure)
        }
      }
      mapOf("id" to job.request.id)
    }

    AsyncFunction("getExport") Coroutine { id: String ->
      requireExportId(id)
      withContext(Dispatchers.IO) {
        requireStore().get(id)?.toJsMap()
          ?: throw IllegalArgumentException("Unknown export: $id")
      }
    }

    AsyncFunction("cancelExport") Coroutine { id: String ->
      requireExportId(id)
      val exportStore = requireStore()
      withContext(Dispatchers.IO) {
        if (exportStore.markCancelled(id)) {
          MediaExportRuntime.cancel(id)
        }
      }
    }

    AsyncFunction("saveToGallery") Coroutine { id: String ->
      requireExportId(id)
      saveToGallery(requireStore(), id)
    }

    AsyncFunction("shareExport") Coroutine { id: String ->
      requireExportId(id)
      shareExport(requireStore(), id)
    }

    OnDestroy {
      store = null
    }
  }

  private fun requireStore(): MediaExportStore =
    store ?: throw Exceptions.AppContextLost()

  private suspend fun saveToGallery(exportStore: MediaExportStore, id: String): String =
    withContext(Dispatchers.IO) {
      val job = exportStore.get(id) ?: throw IllegalArgumentException("Unknown export: $id")
      require(job.status == MediaExportStatus.COMPLETED) {
        "Export is not complete: ${job.status.name.lowercase()}"
      }
      job.galleryUri?.let { return@withContext it }
      val source = exportStore.outputFile(id)
      require(source.isFile && source.length() > 0L) { "Export output is missing" }
      val context = applicationContext()
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Video.Media.DISPLAY_NAME, "one-take-$id.mp4")
        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/One Take")
          put(MediaStore.Video.Media.IS_PENDING, 1)
        } else {
          val directory = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
            "One Take",
          )
          require(directory.isDirectory || directory.mkdirs()) { "Could not create Movies/One Take" }
          put(MediaStore.Video.Media.DATA, File(directory, "one-take-$id.mp4").absolutePath)
        }
      }
      val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
        ?: throw IOException("MediaStore did not create a gallery item")
      try {
        resolver.openOutputStream(uri, "w")?.use { output ->
          source.inputStream().use { input -> input.copyTo(output) }
        } ?: throw IOException("Could not open gallery output")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          resolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) },
            null,
            null,
          )
        }
        val value = uri.toString()
        check(exportStore.setGalleryUri(id, value)) { "Export disappeared while saving" }
        value
      } catch (failure: Throwable) {
        resolver.delete(uri, null, null)
        throw failure
      }
    }

  private suspend fun shareExport(exportStore: MediaExportStore, id: String) {
    val file = withContext(Dispatchers.IO) {
      val job = exportStore.get(id) ?: throw IllegalArgumentException("Unknown export: $id")
      require(job.status == MediaExportStatus.COMPLETED) {
        "Export is not complete: ${job.status.name.lowercase()}"
      }
      exportStore.outputFile(id).also { output ->
        require(output.isFile && output.length() > 0L) { "Export output is missing" }
      }
    }
    withContext(Dispatchers.Main) {
      val context = applicationContext()
      val uri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.oneTakeMedia.files",
        file,
      )
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "video/mp4"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(Intent.createChooser(send, "Share One Take export").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
    }
  }

  private fun applicationContext(): android.content.Context =
    appContext.reactContext?.applicationContext ?: throw Exceptions.AppContextLost()

  private fun requireExportId(id: String) {
    require(id.matches(Regex("[A-Za-z0-9._-]{1,80}"))) { "Invalid export id" }
  }
}
