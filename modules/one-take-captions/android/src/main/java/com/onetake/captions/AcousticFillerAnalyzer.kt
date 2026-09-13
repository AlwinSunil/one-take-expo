package com.onetake.captions

import android.content.Context
import android.net.Uri
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

/** Saved-audio Uhm inference and its source/revision-safe result envelope. */
internal object AcousticFillerAnalyzer {
  private const val MAX_NATIVE_ROW_COUNT = 15_000

  suspend fun analyze(
    context: Context,
    jobId: String,
    sourceId: String,
    sourceUri: String,
    analysisRevision: Int,
  ): Map<String, Any?> = withContext(Dispatchers.Default) {
    require(jobId.isNotBlank()) { "Acoustic filler jobId is required" }
    require(sourceId.isNotBlank()) { "Acoustic filler sourceId is required" }
    require(analysisRevision >= 0) { "Acoustic filler analysisRevision must be non-negative" }

    val startedAtNanos = System.nanoTime()
    val source = appOwnedFile(context, sourceUri)
    val sourceHash = AcousticFillerModel.hashFile(source)
    currentCoroutineContext().ensureActive()
    val audio = AudioDecoder.decodeMono16k(source)
    val durationSeconds = audio.size.toDouble() / AcousticFillerModel.SAMPLE_RATE

    val unavailable = { reason: String ->
      unavailableResult(sourceId, analysisRevision, durationSeconds, reason)
    }

    AcousticFillerModel.baseUnavailableReason(context)?.let { return@withContext unavailable(it) }
    val model = try {
      AcousticFillerModel.prepare(context)
    } catch (failure: AcousticFillerUnavailable) {
      return@withContext unavailable(failure.message ?: "The Uhm model is unavailable")
    }
    currentCoroutineContext().ensureActive()

    val bridgeError = AcousticFillerNative.ensureLoaded()
    if (bridgeError != null) {
      return@withContext unavailable(bridgeError)
    }
    val runtimeVersion = try {
      AcousticFillerNative.runtimeVersion()
    } catch (failure: Throwable) {
      return@withContext unavailable(
        failure.message ?: "The shared Moonshine ONNX Runtime is unavailable",
      )
    }

    val rows = try {
      AcousticFillerNative.detect(
        jobId,
        model.absolutePath,
        audio,
        AcousticFillerModel.THRESHOLD,
      )
    } catch (failure: CancellationException) {
      throw failure
    } catch (failure: Throwable) {
      if (!currentCoroutineContext().isActive) {
        throw CancellationException("Acoustic filler analysis cancelled", failure)
      }
      throw IllegalStateException(
        failure.message ?: "Acoustic filler inference failed",
        failure,
      )
    }
    currentCoroutineContext().ensureActive()

    val sourceHashAfter = AcousticFillerModel.hashFile(source)
    check(sourceHashAfter == sourceHash) {
      "Source audio changed during acoustic filler analysis; discard results and retry"
    }

    val frames = unpackRows(rows, audio.size)
    val events = AcousticFillerSegmentation.segment(frames, audio.size).map { event ->
      val label = when (event.label) {
        AcousticFillerLabel.UM -> "um"
        AcousticFillerLabel.UH -> "uh"
      }
      mapOf<String, Any?>(
        "id" to "$sourceId:filler:$analysisRevision:${event.startSample}:$label",
        "startSeconds" to event.startSample.toDouble() / AcousticFillerModel.SAMPLE_RATE,
        "endSeconds" to event.endSample.toDouble() / AcousticFillerModel.SAMPLE_RATE,
        "label" to label,
        "score" to event.score,
        "timingUncertaintySeconds" to null,
        "timingResolutionSeconds" to AcousticFillerSegmentation.FRAME_SAMPLES.toDouble() / AcousticFillerModel.SAMPLE_RATE,
      )
    }
    val processingSeconds = (System.nanoTime() - startedAtNanos).toDouble() / 1_000_000_000.0

    mapOf(
      "schemaVersion" to 1,
      "status" to "ready",
      "sourceId" to sourceId,
      "analysisRevision" to analysisRevision,
      "model" to mapOf(
        "id" to AcousticFillerModel.MODEL_ID,
        "version" to AcousticFillerModel.MODEL_VERSION,
      ),
      "actualProcessor" to "cpu",
      "durationSeconds" to durationSeconds,
      "events" to events,
      "provenance" to mapOf(
        "source" to "device",
        "runtime" to "onnxruntime-$runtimeVersion-CPUExecutionProvider",
        "audioSha256" to sourceHash,
        "modelSha256" to AcousticFillerModel.MODEL_SHA256,
        "sampleRate" to AcousticFillerModel.SAMPLE_RATE,
        "threshold" to AcousticFillerModel.THRESHOLD.toDouble(),
        "timingSource" to "decoded-pcm-samples",
        "scoreMeaning" to "uncalibrated-model-score",
        "timingNote" to "20 ms model frame coordinates; acoustic boundary error is not measured.",
        "boundaryStatus" to "unverified",
        "releaseValidated" to false,
      ),
      "benchmark" to mapOf(
        "windowCount" to acousticWindowCount(audio.size),
        "processingSeconds" to processingSeconds,
        "realTimeFactor" to processingSeconds / durationSeconds,
        "host" to "android-arm64",
      ),
    )
  }

  private fun unavailableResult(
    sourceId: String,
    analysisRevision: Int,
    durationSeconds: Double,
    reason: String,
  ): Map<String, Any?> = mapOf(
    "schemaVersion" to 1,
    "status" to "unavailable",
    "sourceId" to sourceId,
    "analysisRevision" to analysisRevision,
    "model" to mapOf(
      "id" to AcousticFillerModel.MODEL_ID,
      "version" to AcousticFillerModel.MODEL_VERSION,
    ),
    "actualProcessor" to "unknown",
    "durationSeconds" to durationSeconds,
    "events" to emptyList<Map<String, Any?>>(),
    "unavailableReason" to reason,
  )

  private fun unpackRows(rows: DoubleArray, durationSamples: Int): List<AcousticFillerFrame> {
    require(rows.size % 3 == 0) { "Native acoustic filler rows are malformed" }
    val frameCount = (durationSamples + AcousticFillerSegmentation.FRAME_SAMPLES - 1) /
      AcousticFillerSegmentation.FRAME_SAMPLES
    require(rows.size / 3 == frameCount && frameCount <= MAX_NATIVE_ROW_COUNT) {
      "Native acoustic filler rows do not cover the decoded source"
    }

    return List(frameCount) { index ->
      val offset = index * 3
      val start = rows[offset]
      require(start.isFinite() && start == start.toLong().toDouble()) {
        "Native acoustic filler frame start is malformed"
      }
      val expectedStart = index * AcousticFillerSegmentation.FRAME_SAMPLES
      require(start.toLong() == expectedStart.toLong()) {
        "Native acoustic filler frame coordinates are not contiguous"
      }
      val label = when (rows[offset + 1]) {
        0.0 -> null
        1.0 -> AcousticFillerLabel.UM
        2.0 -> AcousticFillerLabel.UH
        else -> throw IllegalStateException("Native acoustic filler label is malformed")
      }
      AcousticFillerFrame(
        startSample = expectedStart,
        label = label,
        score = rows[offset + 2],
      )
    }
  }

  private fun acousticWindowCount(sampleCount: Int): Int {
    val windowSamples = 479_680
    val hopSamples = 240_000
    return if (sampleCount <= windowSamples) {
      1
    } else {
      1 + (sampleCount - windowSamples + hopSamples - 1) / hopSamples
    }
  }

  private fun appOwnedFile(context: Context, sourceUri: String): File {
    val uri = Uri.parse(sourceUri)
    require(uri.scheme == "file") { "Acoustic filler analysis requires an app-owned file URI" }
    val path = uri.path ?: throw IllegalArgumentException("Acoustic filler source path is missing")
    val file = File(path).canonicalFile
    val roots = listOfNotNull(
      context.filesDir.parentFile?.canonicalFile,
      context.cacheDir.canonicalFile,
    )
    require(roots.any { root ->
      file.path == root.path || file.path.startsWith(root.path + File.separator)
    }) { "Acoustic filler source must be inside app-private storage" }
    require(file.isFile && file.canRead()) { "Acoustic filler source is missing or unreadable" }
    return file
  }
}
