package com.onetake.media

import android.net.Uri
import java.io.File
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

internal const val MAX_SAFE_TIMELINE_REVISION = 9_007_199_254_740_991L

internal enum class MediaExportStatus {
  QUEUED,
  RUNNING,
  COMPLETED,
  CANCELLED,
  FAILED,
  INTERRUPTED,
}

/**
 * A Media3 crop in centered normalized device coordinates.
 *
 * The full frame is [-1, 1] on both axes.  Keeping this representation next
 * to the request means preview and export consume the exact same validated
 * crop, while omitting it retains the legacy original-frame behavior.
 */
internal data class NativeFramingCrop(
  val left: Double,
  val right: Double,
  val bottom: Double,
  val top: Double,
) {
  init {
    require(left.isFinite() && right.isFinite() && bottom.isFinite() && top.isFinite()) {
      "Segment crop coordinates must be finite numbers"
    }
    require(left >= -1.0 && right <= 1.0 && bottom >= -1.0 && top <= 1.0) {
      "Segment crop coordinates must be between -1 and 1"
    }
    require(right > left && top > bottom) {
      "Segment crop bounds must be ordered and non-empty"
    }
  }

  companion object {
    private val COORDINATES = listOf("left", "right", "bottom", "top")

    fun fromMap(value: Any?, label: String): NativeFramingCrop {
      @Suppress("UNCHECKED_CAST")
      val map = value as? Map<String, Any?>
        ?: throw IllegalArgumentException("$label must be an object")
      val coordinates = COORDINATES.map { name ->
        val coordinate = map[name]
        require(coordinate is Number) { "$label field '$name' must be a number" }
        coordinate.toDouble()
      }
      return NativeFramingCrop(
        left = coordinates[0],
        right = coordinates[1],
        bottom = coordinates[2],
        top = coordinates[3],
      )
    }

    fun fromJson(value: JSONObject?, label: String): NativeFramingCrop? {
      if (value == null) return null
      val map = COORDINATES.associateWith { name ->
        if (!value.has(name) || value.isNull(name)) null else value.get(name)
      }
      return fromMap(map, label)
    }
  }
}

internal data class MediaExportRequest(
  val id: String,
  val sourceUri: String,
  val cuts: List<SourceCut>,
  val captions: List<SourceCaption>,
  val segments: List<MediaSourceSegment> = emptyList(),
  val timelineRevision: Long? = null,
) {
  init {
    timelineRevision?.let { revision ->
      require(revision >= 0L && revision <= MAX_SAFE_TIMELINE_REVISION) {
        "timelineRevision must be a nonnegative JavaScript safe integer"
      }
      require(segments.isNotEmpty()) {
        "timelineRevision requires explicit export segments"
      }
    }
  }
}

internal data class MediaExportJob(
  val request: MediaExportRequest,
  val status: MediaExportStatus,
  val progress: Int,
  val uri: String? = null,
  val error: String? = null,
  val galleryUri: String? = null,
  val galleryPending: Boolean = false,
)

private fun parseTimelineRevision(value: Any?): Long? {
  if (value == null || value == JSONObject.NULL) return null
  val number = value as? Number
    ?: throw IllegalArgumentException("Export field 'timelineRevision' must be a number")
  val revision = number.toDouble()
  require(revision.isFinite() && revision >= 0.0 && revision <= MAX_SAFE_TIMELINE_REVISION.toDouble()) {
    "timelineRevision must be a nonnegative JavaScript safe integer"
  }
  require(revision % 1.0 == 0.0) {
    "timelineRevision must be a nonnegative JavaScript safe integer"
  }
  return revision.toLong()
}

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
    val segments = raw.list("segments").mapIndexed { index, value ->
      val map = value.asStringMap("segment", index)
      val nested = parse(mapOf("id" to id, "sourceUri" to map.string("uri"),
        "cuts" to listOf(mapOf("t0" to map.number("t0", "segment", index), "t1" to map.number("t1", "segment", index))),
        "captions" to (map["captions"] ?: emptyList<Any>())))
      val crop = if (map.containsKey("crop")) {
        NativeFramingCrop.fromMap(map["crop"], "segment crop at index $index")
      } else {
        null
      }
      MediaSourceSegment(nested.sourceUri, nested.cuts.single(), nested.captions, crop)
    }
    require(segments.size <= MediaExportTimeline.MAX_CUTS) { "Too many export segments" }
    val timelineRevision = parseTimelineRevision(raw["timelineRevision"])
    return MediaExportRequest(id, sourceUri, cuts, captions, segments, timelineRevision)
  }

  fun parseJson(json: JSONObject): MediaExportRequest {
    fun convert(value: Any?): Any? = when (value) {
      is JSONObject -> value.keys().asSequence().associateWith { convert(value.get(it)) }
      is JSONArray -> (0 until value.length()).map { convert(value.get(it)) }
      JSONObject.NULL -> null
      else -> value
    }
    @Suppress("UNCHECKED_CAST")
    return parse(convert(json) as Map<String, Any?>)
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
    put("segments", JSONArray().apply {
      job.request.segments.forEach { segment -> put(JSONObject().apply {
        put("uri", segment.uri); put("t0", segment.cut.t0); put("t1", segment.cut.t1)
        put("captions", JSONArray().apply { segment.captions.forEach { caption -> put(JSONObject().apply {
          put("t0", caption.t0); put("t1", caption.t1); put("text", caption.text)
        }) } })
        segment.crop?.let { crop -> put("crop", JSONObject().apply {
          put("left", crop.left); put("right", crop.right)
          put("bottom", crop.bottom); put("top", crop.top)
        }) }
      }) }
    })
    job.request.timelineRevision?.let { put("timelineRevision", it) }
    put("status", job.status.name.lowercase(Locale.US))
    put("progress", job.progress.coerceIn(0, 100))
    putNullable("uri", job.uri)
    putNullable("error", job.error)
    putNullable("galleryUri", job.galleryUri)
    put("galleryPending", job.galleryPending)
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
    val segmentJson = value.optJSONArray("segments") ?: JSONArray()
    val segments = (0 until segmentJson.length()).map { index ->
      val segment = segmentJson.getJSONObject(index)
      val captionJson = segment.optJSONArray("captions") ?: JSONArray()
      MediaSourceSegment(segment.getString("uri"), SourceCut(segment.getDouble("t0"), segment.getDouble("t1")),
        (0 until captionJson.length()).map { i -> captionJson.getJSONObject(i).let { SourceCaption(it.getDouble("t0"), it.getDouble("t1"), it.getString("text")) } },
        NativeFramingCrop.fromJson(
          if (segment.has("crop") && !segment.isNull("crop")) segment.getJSONObject("crop") else null,
          "segment crop at index $index",
        ))
    }
    val timelineRevision = parseTimelineRevision(value.opt("timelineRevision"))
    val request = MediaExportRequest(id, sourceUri, cuts, captions, segments, timelineRevision)
    MediaExportTimeline.validateCuts(cuts)
    MediaExportTimeline.validateCaptions(captions)
    return MediaExportJob(
      request = request,
      status = parseStatus(value.getString("status")),
      progress = value.optInt("progress", 0).coerceIn(0, 100),
      uri = value.optNullableString("uri"),
      error = value.optNullableString("error"),
      galleryUri = value.optNullableString("galleryUri"),
      galleryPending = value.optBoolean("galleryPending", false),
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

  fun setGalleryUri(id: String, galleryUri: String?, pending: Boolean = false): Boolean = synchronized(lock) {
    loadLocked()
    val job = jobs[id] ?: return@synchronized false
    if (job.status != MediaExportStatus.COMPLETED) return@synchronized false
    jobs[id] = job.copy(galleryUri = galleryUri, galleryPending = pending)
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
  request.timelineRevision?.let { put("timelineRevision", it) }
  uri?.let { put("uri", it) }
  error?.let { put("error", it) }
  galleryUri?.let { put("galleryUri", it) }
}
