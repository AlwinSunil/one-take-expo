package com.onetake.vision

import android.content.Context
import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.ceil

internal data class VisionAnalyzedFrame(
  val frameId: Long,
  val frameCapturedAtMs: Long,
  val faces: List<VisionFaceBounds>,
  val thermalStatus: VisionThermalStatus,
  val inferenceMs: Long,
  val droppedFrames: Long,
)

internal data class VisionFaceBounds(
  val left: Float,
  val top: Float,
  val right: Float,
  val bottom: Float,
  val trackingId: Int?,
)

/**
 * A CameraX KEEP_ONLY_LATEST analyzer with a single in-flight ML Kit task.
 * Every skipped or completed ImageProxy is closed promptly so optional vision
 * cannot back up the recorder's camera stream.
 */
internal class VisionImageAnalyzer(
  private val context: Context,
  private val onFrame: (VisionAnalyzedFrame) -> Unit,
  private val onError: (Throwable) -> Unit,
  private val onThermalPressure: () -> Unit,
) : ImageAnalysis.Analyzer, AutoCloseable {
  companion object {
    private const val THERMAL_REFRESH_INTERVAL_MS = 2_000L
  }

  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "one-take-vision").apply { isDaemon = true }
  }
  private val detector: FaceDetector = FaceDetection.getClient(
    FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
      .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
      .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
      .setMinFaceSize(0.1f)
      .enableTracking()
      .build(),
  )
  private val closed = AtomicBoolean(false)
  private val inFlight = AtomicBoolean(false)
  private val activeImage = AtomicReference<ImageProxy?>(null)
  private val frameCounter = AtomicLong(0)
  private val framesReceived = AtomicLong(0)
  private val framesDropped = AtomicLong(0)
  private val framesProcessed = AtomicLong(0)
  private val detectorSuccesses = AtomicLong(0)
  private val detectorFailures = AtomicLong(0)
  private val lastInferenceMs = AtomicLong(-1)
  private val inferenceDurationsMs = ConcurrentLinkedQueue<Long>()
  private var nextAllowedAtMs = 0L
  private var thermalCheckedAtMs = 0L
  private var latestThermalStatus = VisionThermalStatus.UNKNOWN
  private val thermalPressureReported = AtomicBoolean(false)

  fun executor() = executor

  override fun analyze(imageProxy: ImageProxy) {
    framesReceived.incrementAndGet()
    if (closed.get()) {
      imageProxy.close()
      return
    }

    val capturedAtMs = SystemClock.elapsedRealtime()
    val thermalStatus = readThermalStatus(capturedAtMs)
    if (VisionDeviceStatusReader.isCritical(thermalStatus)) {
      framesDropped.incrementAndGet()
      imageProxy.close()
      if (thermalPressureReported.compareAndSet(false, true)) {
        onThermalPressure()
      }
      return
    }

    if (capturedAtMs < nextAllowedAtMs
      || !inFlight.compareAndSet(false, true)) {
      framesDropped.incrementAndGet()
      imageProxy.close()
      return
    }
    nextAllowedAtMs = capturedAtMs + VisionDeviceStatusReader.intervalMs(thermalStatus)
    activeImage.set(imageProxy)

    val mediaImage = imageProxy.image
    if (mediaImage == null) {
      inFlight.set(false)
      closeImage(imageProxy)
      return
    }

    val startedAtMs = SystemClock.elapsedRealtime()
    try {
      val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
      detector.process(input)
        .addOnSuccessListener(executor) { faces ->
          if (closed.get()) return@addOnSuccessListener
          val inferenceMs = (SystemClock.elapsedRealtime() - startedAtMs).coerceAtLeast(0L)
          detectorSuccesses.incrementAndGet()
          framesProcessed.incrementAndGet()
          recordInference(inferenceMs)
          val frameId = frameCounter.incrementAndGet()
          onFrame(
            VisionAnalyzedFrame(
              frameId = frameId,
              frameCapturedAtMs = capturedAtMs,
              faces = normalizeFaces(faces, imageProxy),
              thermalStatus = thermalStatus,
              inferenceMs = inferenceMs,
              droppedFrames = framesDropped.get(),
            ),
          )
        }
        .addOnFailureListener(executor) { failure ->
          if (closed.get()) return@addOnFailureListener
          detectorFailures.incrementAndGet()
          onError(failure)
        }
        .addOnCompleteListener(executor) {
          inFlight.set(false)
          closeImage(imageProxy)
        }
    } catch (failure: Throwable) {
      detectorFailures.incrementAndGet()
      inFlight.set(false)
      closeImage(imageProxy)
      onError(failure)
    }
  }

  fun diagnostics(): Map<String, Any?> {
    val durations = inferenceDurationsMs.toList().sorted()
    return mapOf(
      "framesReceived" to framesReceived.get(),
      "framesProcessed" to framesProcessed.get(),
      "framesDropped" to framesDropped.get(),
      "detectorSuccesses" to detectorSuccesses.get(),
      "detectorFailures" to detectorFailures.get(),
      "lastInferenceMs" to lastInferenceMs.get().takeIf { it >= 0L },
      "medianInferenceMs" to percentile(durations, 0.50),
      "p95InferenceMs" to percentile(durations, 0.95),
      "thermalStatus" to latestThermalStatus.wireValue,
    )
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    // Keep an in-flight ImageProxy alive until ML Kit's completion callback.
    // Closing it before the task finishes can invalidate the media.Image that
    // the detector is still reading. The completion listener always closes it,
    // and a graceful executor shutdown lets that listener drain.
    val pendingImage = activeImage.get()
    runCatching { detector.close() }
    executor.shutdown()
    if (pendingImage != null) {
      Thread({
        try {
          if (!executor.awaitTermination(2L, java.util.concurrent.TimeUnit.SECONDS)) {
            closeImage(pendingImage)
          }
        } catch (_: InterruptedException) {
          closeImage(pendingImage)
          Thread.currentThread().interrupt()
        }
      }, "one-take-vision-drain").apply { isDaemon = true }.start()
    }
  }

  private fun readThermalStatus(nowMs: Long): VisionThermalStatus {
    if (nowMs - thermalCheckedAtMs >= THERMAL_REFRESH_INTERVAL_MS) {
      latestThermalStatus = VisionDeviceStatusReader.thermalStatus(context)
      thermalCheckedAtMs = nowMs
    }
    return latestThermalStatus
  }

  private fun normalizeFaces(faces: List<Face>, imageProxy: ImageProxy): List<VisionFaceBounds> {
    val rotation = imageProxy.imageInfo.rotationDegrees
    val frameWidth = if (rotation % 180 == 0) imageProxy.width else imageProxy.height
    val frameHeight = if (rotation % 180 == 0) imageProxy.height else imageProxy.width
    if (frameWidth <= 0 || frameHeight <= 0) return emptyList()

    return faces
      .sortedByDescending { it.boundingBox.width().toLong() * it.boundingBox.height().toLong() }
      .map { face ->
        val bounds = face.boundingBox
        VisionFaceBounds(
          left = (bounds.left.toFloat() / frameWidth).coerceIn(0f, 1f),
          top = (bounds.top.toFloat() / frameHeight).coerceIn(0f, 1f),
          right = (bounds.right.toFloat() / frameWidth).coerceIn(0f, 1f),
          bottom = (bounds.bottom.toFloat() / frameHeight).coerceIn(0f, 1f),
          trackingId = face.trackingId,
        )
      }
  }

  private fun closeImage(image: ImageProxy?) {
    if (image == null) return
    if (activeImage.compareAndSet(image, null)) {
      runCatching { image.close() }
    }
  }

  private fun recordInference(durationMs: Long) {
    lastInferenceMs.set(durationMs)
    inferenceDurationsMs.add(durationMs)
    while (inferenceDurationsMs.size > 128) inferenceDurationsMs.poll()
  }

  private fun percentile(values: List<Long>, percentile: Double): Long? {
    if (values.isEmpty()) return null
    val index = (ceil(values.size * percentile).toInt() - 1).coerceIn(0, values.lastIndex)
    return values[index]
  }
}
