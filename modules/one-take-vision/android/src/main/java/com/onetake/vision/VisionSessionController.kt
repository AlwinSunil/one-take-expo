package com.onetake.vision

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val MODEL_ID = "mlkit-face-16.1.7-bundled"
private const val ENGINE_ID = "mlkit-face"
private const val PROCESSOR_ID = "cpu-fallback"
private const val NPU_UNAVAILABLE_REASON =
  "qnn-face-engine-unavailable: ORT 1.27/1.28 native collision and no reviewed bundled face model"
private const val STALE_FRAME_TIMEOUT_MS = 1_000L

/**
 * Coordinates one optional ImageAnalysis use case with Expo Camera's existing
 * ProcessCameraProvider. It never owns a Preview, VideoCapture or Recording.
 */
internal class VisionSessionController(
  private val context: Context,
  private val activityProvider: () -> Activity?,
  private val onStatus: (Map<String, Any?>) -> Unit,
  private val onFrame: (Map<String, Any?>) -> Unit,
) {
  private val mutex = Mutex()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  @Volatile
  private var activeSession: ActiveSession? = null

  private data class ActiveSession(
    val sessionId: String,
    val lensFacing: String,
    val provider: ProcessCameraProvider,
    val lifecycleOwner: LifecycleOwner,
    val analysis: ImageAnalysis,
    val analyzer: VisionImageAnalyzer,
    val tracker: FacePresenceTracker,
    val lastResultAtMs: AtomicLong = AtomicLong(0L),
    val staleReported: AtomicBoolean = AtomicBoolean(false),
    var staleScheduler: ScheduledExecutorService? = null,
  )

  suspend fun start(sessionId: String, lensFacing: String): Map<String, Any?> = mutex.withLock {
    require(sessionId.isNotBlank()) { "Vision session id is required" }
    require(lensFacing == "front" || lensFacing == "back") { "Unsupported lens facing" }

    stopLocked(emitStopped = true)
    emitStatus(
      sessionId = sessionId,
      lensFacing = lensFacing,
      status = "pending",
      reason = "model-loading",
    )

    val activity = activityProvider()
    val lifecycleOwner = activity as? LifecycleOwner
    if (lifecycleOwner == null) {
      return@withLock unavailableResult(
        sessionId,
        lensFacing,
        "activity-unavailable",
      )
    }

    val provider = try {
      awaitCameraProvider()
    } catch (_: Throwable) {
      return@withLock unavailableResult(sessionId, lensFacing, "no-frame-pipeline")
    }

    val tracker = FacePresenceTracker()
    val analyzer = try {
      VisionImageAnalyzer(
        context = context,
        onFrame = { frame -> handleFrame(sessionId, lensFacing, tracker, frame) },
        onError = { failure -> handleAnalyzerFailure(sessionId, lensFacing, failure) },
        onThermalPressure = { handleThermalPressure(sessionId, lensFacing) },
      )
    } catch (_: Throwable) {
      return@withLock unavailableResult(sessionId, lensFacing, "model-error")
    }
    val analysis = ImageAnalysis.Builder()
      .setTargetResolution(Size(640, 480))
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()
      .also { it.setAnalyzer(analyzer.executor(), analyzer) }
    val active = ActiveSession(
      sessionId = sessionId,
      lensFacing = lensFacing,
      provider = provider,
      lifecycleOwner = lifecycleOwner,
      analysis = analysis,
      analyzer = analyzer,
      tracker = tracker,
    )
    activeSession = active

    try {
      withContext(Dispatchers.Main.immediate) {
        provider.bindToLifecycle(
          lifecycleOwner,
          cameraSelector(lensFacing),
          analysis,
        )
      }
    } catch (_: Throwable) {
      activeSession = null
      closeSession(active)
      return@withLock unavailableResult(sessionId, lensFacing, "camera-binding-failed")
    }

    scheduleStaleCheck(active)
    emitStatus(sessionId, lensFacing, "ready")
    mapOf(
      "status" to "started",
      "sessionId" to sessionId,
      "lensFacing" to lensFacing,
      "engine" to ENGINE_ID,
      "processor" to PROCESSOR_ID,
    )
  }

  suspend fun stop(sessionId: String) = mutex.withLock {
    if (activeSession?.sessionId != sessionId) return@withLock
    stopLocked(emitStopped = true)
  }

  fun deviceStatus(): Map<String, Any?> = VisionDeviceStatusReader.read(context).toMap()

  fun diagnostics(): Map<String, Any?> {
    if (!BuildConfig.DEBUG) {
      return mapOf("enabled" to false, "reason" to "debug-only")
    }

    val active = activeSession
    val values = linkedMapOf<String, Any?>(
      "enabled" to true,
      "moduleVersion" to "0.1.0",
      "model" to MODEL_ID,
      "engine" to ENGINE_ID,
      "processor" to PROCESSOR_ID,
      "npuStatus" to "unavailable",
      "npuUnavailableReason" to NPU_UNAVAILABLE_REASON,
      "sessionId" to active?.sessionId,
      "lensFacing" to active?.lensFacing,
      "buildConfig" to "debug",
      "appVersion" to appVersion(),
      "thermalStatus" to VisionDeviceStatusReader.read(context).thermalStatus.wireValue,
    )
    active?.analyzer?.diagnostics()?.let(values::putAll)
    return values
  }

  /**
   * Backgrounding should release only this module's use case. The recording
   * owner decides whether its own camera session can continue.
   */
  fun requestStopFromLifecycle(reason: String) {
    scope.launch {
      mutex.withLock {
        val active = activeSession ?: return@withLock
        activeSession = null
        closeSession(active)
        emitStatus(
          active.sessionId,
          active.lensFacing,
          "unavailable",
          if (reason == "activity_destroyed") "no-frame-pipeline" else "stale-frame",
        )
      }
    }
  }

  fun close() {
    val active = activeSession
    activeSession = null
    if (active != null) {
      active.staleScheduler?.shutdownNow()
      runCatching {
        Handler(Looper.getMainLooper()).post {
          runCatching { active.provider.unbind(active.analysis) }
          runCatching { active.analysis.clearAnalyzer() }
          active.analyzer.close()
        }
      }
    }
    scope.cancel()
  }

  private suspend fun stopLocked(emitStopped: Boolean) {
    val active = activeSession ?: return
    activeSession = null
    closeSession(active)
    if (emitStopped) emitStatus(active.sessionId, active.lensFacing, "stopped")
  }

  private suspend fun closeSession(active: ActiveSession) {
    active.staleScheduler?.shutdownNow()
    withContext(Dispatchers.Main.immediate) {
      runCatching { active.provider.unbind(active.analysis) }
      runCatching { active.analysis.clearAnalyzer() }
    }
    active.analyzer.close()
  }

  private fun scheduleStaleCheck(active: ActiveSession) {
    val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "one-take-vision-stale").apply { isDaemon = true }
    }
    active.staleScheduler = scheduler
    scheduler.scheduleAtFixedRate({
      if (activeSession !== active) return@scheduleAtFixedRate
      val lastResultAtMs = active.lastResultAtMs.get()
      val nowMs = android.os.SystemClock.elapsedRealtime()
      if (lastResultAtMs > 0L
        && nowMs - lastResultAtMs >= STALE_FRAME_TIMEOUT_MS
        && active.staleReported.compareAndSet(false, true)) {
        active.tracker.reset()
        emitStatus(active.sessionId, active.lensFacing, "unavailable", "stale-frame")
      }
    }, 500L, 500L, TimeUnit.MILLISECONDS)
  }

  private fun handleFrame(
    sessionId: String,
    lensFacing: String,
    tracker: FacePresenceTracker,
    frame: VisionAnalyzedFrame,
  ) {
    val active = activeSession ?: return
    if (active.sessionId != sessionId || active.lensFacing != lensFacing || active.tracker !== tracker) return

    active.lastResultAtMs.set(frame.frameCapturedAtMs)
    val wasStale = active.staleReported.getAndSet(false)
    val stable = tracker.update(frame.faces.isNotEmpty(), frame.frameCapturedAtMs)
    if (wasStale) emitStatus(sessionId, lensFacing, "ready")
    onFrame(
      mapOf(
        "sessionId" to sessionId,
        "lensFacing" to lensFacing,
        "frameId" to frame.frameId,
        "frameCapturedAtMs" to frame.frameCapturedAtMs,
        "frameEmittedAtMs" to android.os.SystemClock.elapsedRealtime(),
        "facePresent" to stable.facePresent,
        "stable" to stable.stable,
        "stableForMs" to stable.stableForMs,
        "faces" to frame.faces.map { it.toMap() },
        "thermalStatus" to frame.thermalStatus.wireValue,
        "droppedFrames" to frame.droppedFrames,
        "inferenceMs" to frame.inferenceMs,
      ),
    )
  }

  private fun handleAnalyzerFailure(sessionId: String, lensFacing: String, failure: Throwable) {
    scope.launch {
      mutex.withLock {
        val active = activeSession
        if (active?.sessionId != sessionId || active.lensFacing != lensFacing) return@withLock
        activeSession = null
        closeSession(active)
        emitStatus(sessionId, lensFacing, "unavailable", "model-error", failure.message)
      }
    }
  }

  private fun handleThermalPressure(sessionId: String, lensFacing: String) {
    scope.launch {
      mutex.withLock {
        val active = activeSession
        if (active?.sessionId != sessionId || active.lensFacing != lensFacing) return@withLock
        activeSession = null
        closeSession(active)
        emitStatus(sessionId, lensFacing, "unavailable", "thermal-pressure")
      }
    }
  }

  private fun emitStatus(
    sessionId: String,
    lensFacing: String,
    status: String,
    reason: String? = null,
    error: String? = null,
  ) {
    val values = linkedMapOf<String, Any?>(
      "sessionId" to sessionId,
      "lensFacing" to lensFacing,
      "status" to status,
      "reason" to reason,
      "engine" to if (status == "unavailable" && reason != "stale-frame") "none" else ENGINE_ID,
      "processor" to if (status == "unavailable" && reason != "stale-frame") "unknown" else PROCESSOR_ID,
      "model" to MODEL_ID,
      "npuStatus" to "unavailable",
      "npuUnavailableReason" to NPU_UNAVAILABLE_REASON,
    )
    if (status == "ready" || status == "unavailable") {
      values["device"] = VisionDeviceStatusReader.read(context).toMap()
    }
    if (error != null) values["error"] = error.take(240)
    onStatus(values)
  }

  private fun unavailableResult(
    sessionId: String,
    lensFacing: String,
    reason: String,
  ): Map<String, Any?> {
    emitStatus(sessionId, lensFacing, "unavailable", reason)
    return mapOf(
      "status" to "unavailable",
      "sessionId" to sessionId,
      "lensFacing" to lensFacing,
      "engine" to "none",
      "processor" to "unknown",
      "reason" to reason,
    )
  }

  private suspend fun awaitCameraProvider(): ProcessCameraProvider = withContext(Dispatchers.Main.immediate) {
    suspendCancellableCoroutine { continuation ->
      try {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
          {
            try {
              if (continuation.isActive) continuation.resume(future.get())
            } catch (failure: Throwable) {
              if (continuation.isActive) continuation.resumeWithException(failure)
            }
          },
          ContextCompat.getMainExecutor(context),
        )
      } catch (failure: Throwable) {
        if (continuation.isActive) continuation.resumeWithException(failure)
      }
    }
  }

  private fun cameraSelector(lensFacing: String): CameraSelector = CameraSelector.Builder()
    .requireLensFacing(
      if (lensFacing == "front") CameraSelector.LENS_FACING_FRONT
      else CameraSelector.LENS_FACING_BACK,
    )
    .build()

  private fun appVersion(): String? = runCatching {
    @Suppress("DEPRECATION")
    context.packageManager.getPackageInfo(context.packageName, 0).versionName
  }.getOrNull()

  private fun VisionFaceBounds.toMap(): Map<String, Any?> = mapOf(
    "left" to left.toDouble(),
    "top" to top.toDouble(),
    "right" to right.toDouble(),
    "bottom" to bottom.toDouble(),
    "trackingId" to trackingId,
  )
}
