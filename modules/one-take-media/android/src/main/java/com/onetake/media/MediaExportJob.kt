package com.onetake.media

import android.net.Uri
import java.io.File
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

internal enum class MediaExportStatus {
  QUEUED,
  RUNNING,
  COMPLETED,
  CANCELLED,
  FAILED,
  INTERRUPTED,
}

internal data class MediaExportRequest(
  val id: String,
  val sourceUri: String,
  val cuts: List<SourceCut>,
  val captions: List<SourceCaption>,
)

internal data class MediaExportJob(
  val request: MediaExportRequest,
  val status: MediaExportStatus,
  val progress: Int,
  val uri: String? = null,
  val error: String? = null,
  val galleryUri: String? = null,
)

internal object MediaExportRequestParser {
  private val idPattern = Regex("[A-Za-z0-9._-]{1,80}")

  fun parse(raw: Map<String, Any?>): MediaExportRequest {
    val id = raw.string("id")
    require(idPattern.matches(id)) {
      "Export id must contain only letters, numbers, '.', '_' or '-'"
    }
    val sourceUri = raw.string("sourceUri")
    val uri = Uri.parse(sourceUri)
    require(uri.scheme in setOf("file", "content", "android.resource")) {
      "Exports accept only local file or content URIs"
    }

    val cuts = raw.list("cuts").mapIndexed { index, value ->
      val map = value.asStringMap("cut", index)
      SourceCut(map.number("t0", "cut", index), map.number("t1", "cut", index))
    }
    val captions = raw.list("captions").mapIndexed { index, value ->
      val map = value.asStringMap("caption", index)
      SourceCaption(
        map.number("t0", "caption", index),
        map.number("t1", "caption", index),
        map.string("text"),
      )
    }
    MediaExportTimeline.validateCuts(cuts)
    MediaExportTimeline.validateCaptions(captions)
    return MediaExportRequest(id, sourceUri, cuts, captions)
  }

  private fun Map<String, Any?>.string(name: String): String {
    return this[name] as? String
      ?: throw IllegalArgumentException("Export field '$name' must be a string")
  }

  private fun Map<String, Any?>.list(name: String): List<Any?> {
    val value = this[name] ?: return emptyList()
    @Suppress("UNCHECKED_CAST")
    return value as? List<Any?>
      ?: throw IllegalArgumentException("Export field '$name' must be an array")
  }

  private fun Any?.asStringMap(label: String, index: Int): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return this as? Map<String, Any?>
      ?: throw IllegalArgumentException("$label at index $index must be an object")
  }

  private fun Map<String, Any?>.number(name: String, label: String, index: Int): Double {
    val value = this[name]
    return when (value) {
      is Number -> value.toDouble()
      else -> throw IllegalArgumentException("$label field '$name' at index $index must be a number")
    }
  }
}

internal object MediaExportJobJson {
  fun encode(job: MediaExportJob): JSONObject = JSONObject().apply {
    put("id", job.request.id)
    put("sourceUri", job.request.sourceUri)
    put("cuts", JSONArray().apply {
      job.request.cuts.forEach { cut ->
        put(JSONObject().apply {
          put("t0", cut.t0)
          put("t1", cut.t1)
        })
      }
    })
    put("captions", JSONArray().apply {
      job.request.captions.forEach { caption ->
        put(JSONObject().apply {
          put("t0", caption.t0)
          put("t1", caption.t1)
          put("text", caption.text)
        })
      }
    })
    put("status", job.status.name.lowercase(Locale.US))
    put("progress", job.progress.coerceIn(0, 100))
    putNullable("uri", job.uri)
    putNullable("error", job.error)
    putNullable("galleryUri", job.galleryUri)
  }

  fun decode(value: JSONObject): MediaExportJob {
    val id = value.getString("id")
    val sourceUri = value.getString("sourceUri")
    val cutsJson = value.optJSONArray("cuts") ?: JSONArray()
    val cuts = buildList(cutsJson.length()) {
      for (index in 0 until cutsJson.length()) {
        val item = cutsJson.getJSONObject(index)
        add(SourceCut(item.getDouble("t0"), item.getDouble("t1")))
      }
    }
    val captionsJson = value.optJSONArray("captions") ?: JSONArray()
    val captions = buildList(captionsJson.length()) {
      for (index in 0 until captionsJson.length()) {
        val item = captionsJson.getJSONObject(index)
        add(SourceCaption(item.getDouble("t0"), item.getDouble("t1"), item.getString("text")))
      }
    }
    val request = MediaExportRequest(id, sourceUri, cuts, captions)
    MediaExportTimeline.validateCuts(cuts)
    MediaExportTimeline.validateCaptions(captions)
    return MediaExportJob(
      request = request,
      status = parseStatus(value.getString("status")),
      progress = value.optInt("progress", 0).coerceIn(0, 100),
      uri = value.optNullableString("uri"),
      error = value.optNullableString("error"),
      galleryUri = value.optNullableString("galleryUri"),
    )
  }

  private fun JSONObject.putNullable(name: String, value: String?) {
    put(name, value ?: JSONObject.NULL)
  }

  private fun JSONObject.optNullableString(name: String): String? =
    if (isNull(name)) null else getString(name)

  private fun parseStatus(value: String): MediaExportStatus = when (value.lowercase(Locale.US)) {
    "queued" -> MediaExportStatus.QUEUED
    "running" -> MediaExportStatus.RUNNING
    "completed" -> MediaExportStatus.COMPLETED
    "cancelled" -> MediaExportStatus.CANCELLED
    "failed" -> MediaExportStatus.FAILED
    "interrupted" -> MediaExportStatus.INTERRUPTED
    else -> throw IllegalArgumentException("Unknown export status: $value")
  }
}

internal class MediaExportStore(context: android.content.Context) {
  // The Expo module and the foreground service each create a store instance,
  // but both instances run in the same app process and share these files.
  // A process-wide lock keeps cancellation, progress, and state replacement
  // from interleaving their temporary-file writes.
  private val lock = PROCESS_LOCK
  private val directory = File(context.applicationContext.filesDir, "exports")
  private val stateFile = File(directory, "jobs.json")
  private val temporaryStateFile = File(directory, ".jobs.json.part")
  private val jobs = linkedMapOf<String, MediaExportJob>()

  init {
    synchronized(lock) {
      loadLocked()
    }
  }

  fun outputFile(id: String): File = File(directory, "$id.mp4")

  fun enqueue(request: MediaExportRequest): MediaExportJob = synchronized(lock) {
    loadLocked()
    MediaExportRuntime.clearCancellation(request.id)
    val existing = jobs[request.id]
    when (existing?.status) {
      MediaExportStatus.QUEUED, MediaExportStatus.RUNNING ->
        throw IllegalStateException("Export is already active: ${request.id}")
      MediaExportStatus.COMPLETED -> {
        if (outputFile(request.id).isFile) return@synchronized existing
      }
      null, MediaExportStatus.CANCELLED, MediaExportStatus.FAILED, MediaExportStatus.INTERRUPTED -> Unit
    }
    val job = MediaExportJob(request, MediaExportStatus.QUEUED, 0)
    jobs[request.id] = job
    persistLocked()
    job
  }

  fun get(id: String): MediaExportJob? = synchronized(lock) {
    loadLocked()
    val job = jobs[id]
    if (job?.status == MediaExportStatus.COMPLETED && (!outputFile(id).isFile || outputFile(id).length() == 0L)) {
      val missing = job.copy(status = MediaExportStatus.FAILED, uri = null, error = "Export output is missing. Retry to create it again.")
      jobs[id] = missing
      persistLocked()
      missing
    } else job
  }

  fun delete(id: String) = synchronized(lock) {
    loadLocked()
    check(!MediaExportRuntime.isActive(id)) { "Export is still stopping. Retry deletion." }
    listOf(outputFile(id), File(directory, ".$id.mp4.part")).forEach { file ->
      check(!file.exists() || file.delete()) { "Could not delete export output" }
    }
    jobs.remove(id)
    persistLocked()
  }

  fun markRunning(id: String): Boolean = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized false
    if (job.status != MediaExportStatus.QUEUED) return@synchronized false
    jobs[id] = job.copy(status = MediaExportStatus.RUNNING, progress = 0, error = null)
    persistLocked()
    true
  }

  fun updateProgress(id: String, progress: Int) = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized
    if (job.status != MediaExportStatus.RUNNING) return@synchronized
    val bounded = progress.coerceIn(job.progress, 99)
    if (bounded == job.progress) return@synchronized
    jobs[id] = job.copy(progress = bounded)
    persistLocked()
  }

  fun markCompleted(id: String, uri: String): Boolean = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized false
    if (job.status != MediaExportStatus.RUNNING) return@synchronized false
    jobs[id] = job.copy(
      status = MediaExportStatus.COMPLETED,
      progress = 100,
      uri = uri,
      error = null,
      galleryUri = null,
    )
    persistLocked()
    true
  }

  fun markFailed(id: String, message: String) = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized
    if (job.status != MediaExportStatus.QUEUED && job.status != MediaExportStatus.RUNNING) {
      return@synchronized
    }
    jobs[id] = job.copy(
      status = MediaExportStatus.FAILED,
      error = message.take(MAX_ERROR_LENGTH),
    )
    persistLocked()
  }

  fun markCancelled(id: String): Boolean = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized false
    when (job.status) {
      MediaExportStatus.QUEUED, MediaExportStatus.RUNNING -> {
        jobs[id] = job.copy(status = MediaExportStatus.CANCELLED, error = null)
        MediaExportRuntime.markCancelled(id)
        persistLocked()
        true
      }
      else -> false
    }
  }

  fun markInterruptedRunningJobs() = synchronized(lock) {
    loadLocked()
    var changed = false
    jobs.entries.forEach { (id, job) ->
      if (job.status in setOf(MediaExportStatus.QUEUED, MediaExportStatus.RUNNING) && !MediaExportRuntime.isActive(id)) {
        jobs[id] = job.copy(
          status = MediaExportStatus.INTERRUPTED,
          error = "Export stopped before it finished. Retry to start it again.",
        )
        changed = true
      }
    }
    if (changed) persistLocked()
  }

  fun markInterrupted(id: String, message: String) = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized
    if (job.status != MediaExportStatus.RUNNING) return@synchronized
    jobs[id] = job.copy(
      status = MediaExportStatus.INTERRUPTED,
      error = message.take(MAX_ERROR_LENGTH),
    )
    persistLocked()
  }

  fun setGalleryUri(id: String, galleryUri: String): Boolean = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized false
    if (job.status != MediaExportStatus.COMPLETED) return@synchronized false
    jobs[id] = job.copy(galleryUri = galleryUri)
    persistLocked()
    true
  }

  private fun loadLocked() {
    // A temporary record can be newer than the last successfully renamed
    // record when the process died during persistence. Prefer it, then fall
    // back to the previous durable state if the write was incomplete.
    val candidates = listOf(temporaryStateFile, stateFile)
      .filter { it.isFile }
      .sortedByDescending { it.lastModified() }
    if (candidates.isEmpty()) {
      jobs.clear()
      return
    }
    var lastFailure: Throwable? = null
    for (readableState in candidates) {
      try {
        val root = JSONObject(readableState.readText())
        val array = root.optJSONArray("jobs") ?: JSONArray()
        val loaded = linkedMapOf<String, MediaExportJob>()
        for (index in 0 until array.length()) {
          val job = MediaExportJobJson.decode(array.getJSONObject(index))
          loaded[job.request.id] = job
        }
        jobs.clear()
        jobs.putAll(loaded)
        return
      } catch (failure: Throwable) {
        lastFailure = failure
      }
    }
    throw IllegalStateException("Export state is unreadable", lastFailure)
  }

  private fun persistLocked() {
    check(directory.isDirectory || directory.mkdirs()) {
      "Could not create app-private export directory"
    }
    val root = JSONObject().apply {
      put("version", 1)
      put("jobs", JSONArray().apply { jobs.values.forEach { put(MediaExportJobJson.encode(it)) } })
    }
    temporaryStateFile.writeText(root.toString())
    if (!temporaryStateFile.renameTo(stateFile)) {
      // File.renameTo is allowed to refuse replacing an existing destination
      // on some Android filesystems. The temporary file remains available for
      // recovery if the second rename fails.
      check(!stateFile.exists() || stateFile.delete()) {
        "Could not replace previous export state"
      }
      check(temporaryStateFile.renameTo(stateFile)) { "Could not persist export state" }
    }
  }

  companion object {
    private val PROCESS_LOCK = Any()
    private const val MAX_ERROR_LENGTH = 1_000
  }
}

internal fun MediaExportJob.toJsMap(): Map<String, Any?> = buildMap {
  put("id", request.id)
  put("status", status.name.lowercase(Locale.US))
  put("progress", progress.coerceIn(0, 100))
  uri?.let { put("uri", it) }
  error?.let { put("error", it) }
}
