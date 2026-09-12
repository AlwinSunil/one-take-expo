package com.onetake.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.Spannable
import android.text.SpannableString
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.media3.common.MediaItem
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Runs one Media3 export and publishes only a completed sibling file.
 * Transformer is constructed, started, polled and cancelled on the main
 * looper, as required by the Media3 API.
 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class MediaExportRunner(
  private val context: Context,
  private val store: MediaExportStore,
) {
  suspend fun run(
    job: MediaExportJob,
    output: File,
    onProgress: suspend (Int) -> Unit,
  ): File {
    val parent = output.parentFile ?: throw IllegalArgumentException("Export output has no parent")
    check(parent.isDirectory || parent.mkdirs()) { "Could not create export directory" }
    val sourceUri = Uri.parse(job.request.sourceUri)
    sourceUri.path?.let { sourcePath ->
      if (sourceUri.scheme == "file") {
        require(File(sourcePath).isFile) { "Export source does not exist: $sourcePath" }
      }
      require(output.canonicalFile != File(sourcePath).canonicalFile) {
        "Export output must be different from the source"
      }
    }

    // A retry may leave a previous completed result behind. It is only removed
    // after the request was accepted as a retry, and the source remains intact.
    if (output.exists() && !output.delete()) {
      throw IOException("Could not replace the previous export output")
    }
    val temporary = File(parent, ".${job.request.id}.mp4.part")
    if (temporary.exists() && !temporary.delete()) {
      throw IOException("Could not remove an interrupted export temporary file")
    }

    try {
      val composition = withContext(Dispatchers.IO) { MediaComposition.build(context, job.request) }
      withContext(Dispatchers.Main.immediate) {
        exportOnMain(job, temporary, composition, onProgress)
      }
      ensureNotCancelled(job.request.id)
      if (!temporary.renameTo(output)) {
        throw IOException("Could not publish completed export")
      }
      return output
    } catch (cancelled: CancellationException) {
      temporary.delete()
      // Cancellation can race the final temporary-to-output rename. Remove
      // either path so a cancelled job cannot leave an untracked video behind.
      output.delete()
      throw cancelled
    } catch (failure: Throwable) {
      temporary.delete()
      throw failure
    }
  }

  private suspend fun exportOnMain(
    job: MediaExportJob,
    temporary: File,
    composition: Composition,
    onProgress: suspend (Int) -> Unit,
  ) {
    check(Looper.myLooper() == Looper.getMainLooper()) {
      "Media3 Transformer must be accessed from the main thread"
    }
    ensureNotCancelledOnMain(job.request.id)

    val transformer = Transformer.Builder(context.applicationContext)
      .setAssetLoaderFactory(androidx.media3.transformer.ExoPlayerAssetLoader.Factory(
        context.applicationContext,
        androidx.media3.transformer.DefaultDecoderFactory.Builder(context.applicationContext).build(),
        androidx.media3.common.util.Clock.DEFAULT,
        DecodeAheadMediaSourceFactory(context.applicationContext),
      )).build()
    val mainHandler = Handler(Looper.getMainLooper())
    val registered = AtomicBoolean(false)
    val progressJob: Job = CoroutineScope(currentCoroutineContext()).launch {
      val holder = ProgressHolder()
      var lastProgress = 0
      while (isActive) {
        if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          val progress = holder.progress.coerceIn(lastProgress, 99)
          if (progress > lastProgress) {
            lastProgress = progress
            withContext(Dispatchers.IO) { onProgress(progress) }
          }
        }
        delay(PROGRESS_POLL_INTERVAL_MS)
      }
    }

    var listener: Transformer.Listener? = null
    try {
      suspendCancellableCoroutine<Unit> { continuation ->
        val started = AtomicBoolean(false)
        val exportListener = object : Transformer.Listener {
          override fun onCompleted(
            composition: Composition,
            exportResult: androidx.media3.transformer.ExportResult,
          ) {
            if (continuation.isActive) continuation.resume(Unit)
          }

          override fun onError(
            composition: Composition,
            exportResult: androidx.media3.transformer.ExportResult,
            exportException: ExportException,
          ) {
            if (!continuation.isActive) return
            if (MediaExportRuntime.isCancelled(job.request.id)) {
              continuation.cancel(CancellationException("Export cancelled"))
            } else {
              continuation.resumeWithException(exportException)
            }
          }
        }
        listener = exportListener
        transformer.addListener(exportListener)
        MediaExportRuntime.register(job.request.id) {
          // Transformer.cancel() does not guarantee a listener callback. Tie
          // runtime cancellation directly to the continuation so the service
          // can finish cleanup even when Media3 is already stopping.
          mainHandler.post {
            if (continuation.isActive) {
              runCatching { transformer.cancel() }
              continuation.cancel(CancellationException("Export cancelled"))
            }
          }
        }
        registered.set(true)
        continuation.invokeOnCancellation {
          mainHandler.post {
            if (started.get()) runCatching { transformer.cancel() }
            runCatching { transformer.removeListener(exportListener) }
          }
        }
        try {
          ensureNotCancelledOnMain(job.request.id)
          started.set(true)
          transformer.start(composition, temporary.path)
        } catch (failure: Throwable) {
          if (continuation.isActive) continuation.resumeWithException(failure)
        }
      }
    } finally {
      progressJob.cancel()
      listener?.let { transformer.removeListener(it) }
      if (registered.get()) MediaExportRuntime.unregister(job.request.id)
    }
  }

  private fun ensureNotCancelled(id: String) {
    if (MediaExportRuntime.isCancelled(id) || store.get(id)?.status == MediaExportStatus.CANCELLED) {
      throw CancellationException("Export cancelled")
    }
  }

  private fun ensureNotCancelledOnMain(id: String) {
    if (MediaExportRuntime.isCancelled(id)) {
      throw CancellationException("Export cancelled")
    }
  }

  @androidx.annotation.OptIn(markerClass = [UnstableApi::class])
  internal class TimedCaptionOverlay(
    private val captions: List<MappedCaption>,
  ) : BitmapOverlay() {
    private val activeSettings = StaticOverlaySettings.Builder()
      // Lower third with space above the bottom edge for player controls.
      .setBackgroundFrameAnchor(0f, -0.66f)
      .setOverlayFrameAnchor(0f, -1f)
      .build()
    private val hiddenSettings = StaticOverlaySettings.Builder()
      .setAlphaScale(0f)
      .build()
    // BitmapOverlay requires a non-empty bitmap even when no caption is active.
    private val blankBitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    private val measurePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = TEXT_SIZE_PIXELS.toFloat()
    }
    private var textSizeScale = 0.5f
    private var maxTextWidth = DEFAULT_MAX_TEXT_WIDTH.toInt()
    private var maxTextHeight = DEFAULT_MAX_TEXT_HEIGHT.toInt()
    private var textPadding = DEFAULT_TEXT_PADDING
    private var cachedCaptionIndex = -1
    private var cachedCaptionBitmap: Bitmap? = null

    override fun configure(videoSize: Size) {
      super.configure(videoSize)
      maxTextWidth = (videoSize.width * MAX_TEXT_WIDTH_FRACTION).toInt().coerceAtLeast(1)
      textSizeScale = (videoSize.width * TEXT_SIZE_FRACTION / TEXT_SIZE_PIXELS)
        .coerceIn(MIN_TEXT_SIZE_SCALE, MAX_TEXT_SIZE_SCALE)
      maxTextHeight = (videoSize.height * MAX_TEXT_HEIGHT_FRACTION).toInt().coerceAtLeast(1)
      textPadding = (videoSize.width * TEXT_PADDING_FRACTION).toInt()
        .coerceIn(MIN_TEXT_PADDING, MAX_TEXT_PADDING)
      cachedCaptionBitmap?.recycle()
      cachedCaptionBitmap = null
      cachedCaptionIndex = -1
    }

    override fun getBitmap(presentationTimeUs: Long): Bitmap {
      val index = captionIndexAt(presentationTimeUs)
      if (index < 0) return blankBitmap
      if (cachedCaptionIndex != index) {
        cachedCaptionBitmap?.recycle()
        cachedCaptionBitmap = renderCaption(captions[index].text)
        cachedCaptionIndex = index
      }
      return checkNotNull(cachedCaptionBitmap)
    }

    override fun getOverlaySettings(presentationTimeUs: Long): StaticOverlaySettings =
      if (captionIndexAt(presentationTimeUs) < 0) hiddenSettings else activeSettings

    override fun release() {
      cachedCaptionBitmap?.recycle()
      cachedCaptionBitmap = null
      blankBitmap.recycle()
      super.release()
    }

    private fun captionIndexAt(timeUs: Long): Int {
      var low = 0
      var high = captions.lastIndex
      var candidate = -1
      while (low <= high) {
        val middle = (low + high) ushr 1
        if (captions[middle].startUs <= timeUs) {
          candidate = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      return if (candidate >= 0 && timeUs < captions[candidate].endUs) candidate else -1
    }

    private fun renderCaption(rawText: String): Bitmap {
      // Treat captions as a readable lower-third block. Collapse source line
      // breaks so a malformed long paragraph cannot create an unbounded bitmap.
      val text = rawText.replace(Regex("\\s+"), " ").trim()
      var low = MIN_TEXT_SIZE_SCALE
      var high = textSizeScale
      var bestText = wrapText(text, maxTextWidth.toFloat(), low)
      var bestLayout = createLayout(bestText, low)
      repeat(SCALE_SEARCH_STEPS) {
        val candidateScale = (low + high) / 2f
        val candidateText = wrapText(text, maxTextWidth.toFloat(), candidateScale)
        val candidateLayout = createLayout(candidateText, candidateScale)
        if (candidateLayout.height <= innerMaxHeight()) {
          bestText = candidateText
          bestLayout = candidateLayout
          low = candidateScale
        } else {
          high = candidateScale
        }
      }
      // Reject unreadable captions instead of shrinking text beyond a legible size.
      require(bestLayout.height <= innerMaxHeight()) { "A caption is too long to display clearly. Split or shorten it before exporting." }
      val bitmapWidth = maxTextWidth.coerceAtLeast(1)
      val bitmapHeight = (bestLayout.height + (2 * textPadding)).coerceAtLeast(1)
      return Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888).also { bitmap ->
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        canvas.translate(textPadding.toFloat(), textPadding.toFloat())
        bestLayout.draw(canvas)
      }
    }

    private fun createLayout(text: String, scale: Float): StaticLayout {
      val styled = styledText(text)
      measurePaint.textSize = TEXT_SIZE_PIXELS * scale
      return StaticLayout.Builder.obtain(
        styled,
        0,
        styled.length,
        measurePaint,
        innerMaxWidth(),
      )
        .setIncludePad(false)
        .build()
    }

    private fun styledText(text: String): SpannableString = SpannableString(text).also { value ->
      if (value.isNotEmpty()) {
        value.setSpan(
          StyleSpan(Typeface.BOLD),
          0,
          value.length,
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        value.setSpan(
          ForegroundColorSpan(Color.WHITE),
          0,
          value.length,
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        value.setSpan(
          BackgroundColorSpan(0xB0000000.toInt()),
          0,
          value.length,
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
      }
    }

    private fun wrapText(text: String, maxWidth: Float, scale: Float): String {
      measurePaint.textSize = TEXT_SIZE_PIXELS * scale
      val lines = ArrayList<String>()
      var current = ""
      text.split(Regex("\\s+")).filter { it.isNotEmpty() }.forEach { word ->
        if (measurePaint.measureText(word) > maxWidth) {
          if (current.isNotEmpty()) {
            lines += current
            current = ""
          }
          val chunks = breakLongWord(word, maxWidth)
          if (chunks.size > 1) lines += chunks.dropLast(1)
          current = chunks.lastOrNull().orEmpty()
        } else {
          val candidate = if (current.isEmpty()) word else "$current $word"
          if (current.isEmpty() || measurePaint.measureText(candidate) <= maxWidth) {
            current = candidate
          } else {
            lines += current
            current = word
          }
        }
      }
      if (current.isNotEmpty()) lines += current
      return lines.joinToString("\n")
    }

    private fun breakLongWord(word: String, maxWidth: Float): List<String> {
      val chunks = ArrayList<String>()
      var current = ""
      word.forEach { character ->
        val candidate = current + character
        if (current.isNotEmpty() && measurePaint.measureText(candidate) > maxWidth) {
          chunks += current
          current = character.toString()
        } else {
          current = candidate
        }
      }
      if (current.isNotEmpty()) chunks += current
      return if (chunks.isEmpty()) listOf(word) else chunks
    }

    private fun innerMaxWidth(): Int = (maxTextWidth - (2 * textPadding)).coerceAtLeast(1)

    private fun innerMaxHeight(): Int = (maxTextHeight - (2 * textPadding)).coerceAtLeast(1)

    companion object {
      private const val TEXT_SIZE_PIXELS = 100
      private const val MAX_TEXT_WIDTH_FRACTION = 0.86f
      private const val TEXT_SIZE_FRACTION = 0.06f
      private const val MAX_TEXT_HEIGHT_FRACTION = 0.30f
      private const val TEXT_PADDING_FRACTION = 0.018f
      private const val MIN_TEXT_PADDING = 4
      private const val MAX_TEXT_PADDING = 32
      private const val MIN_TEXT_SIZE_SCALE = 0.24f
      private const val MAX_TEXT_SIZE_SCALE = 0.85f
      private const val SCALE_SEARCH_STEPS = 8
      private const val DEFAULT_MAX_TEXT_WIDTH = 900f
      private const val DEFAULT_MAX_TEXT_HEIGHT = 320f
      private const val DEFAULT_TEXT_PADDING = 16
    }
  }

  companion object {
    private const val PROGRESS_POLL_INTERVAL_MS = 250L
  }
}

/** Process-local cancellation bridge shared by the Expo module and service. */
internal object MediaExportRuntime {
  private val lock = Any()
  private val cancelCallbacks = linkedMapOf<String, () -> Unit>()
  private val activeIds = linkedSetOf<String>()
  private val cancelledIds = linkedSetOf<String>()

  fun markActive(id: String) = synchronized(lock) {
    activeIds += id
  }

  fun markInactive(id: String) = synchronized(lock) {
    activeIds -= id
    cancelCallbacks.remove(id)
    cancelledIds -= id
  }

  fun isActive(id: String): Boolean = synchronized(lock) { id in activeIds }

  fun markCancelled(id: String) = synchronized(lock) {
    cancelledIds += id
  }

  fun clearCancellation(id: String) = synchronized(lock) {
    cancelledIds -= id
  }

  fun isCancelled(id: String): Boolean = synchronized(lock) { id in cancelledIds }

  fun register(id: String, cancel: () -> Unit) = synchronized(lock) {
    cancelCallbacks[id] = cancel
  }

  fun cancel(id: String): Boolean = synchronized(lock) {
    cancelCallbacks[id]?.let { callback ->
      callback()
      true
    } ?: false
  }

  fun unregister(id: String) = synchronized(lock) {
    cancelCallbacks.remove(id)
  }
}
