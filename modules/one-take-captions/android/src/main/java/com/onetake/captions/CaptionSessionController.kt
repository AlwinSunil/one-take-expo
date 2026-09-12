package com.onetake.captions

import android.os.Build
import android.util.Log
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext

/**
 * Owns one microphone and one Moonshine stream for the lifetime of a capture.
 *
 * The controller deliberately keeps its own scope instead of using the Expo
 * call scope. A JS start promise can be cancelled when a screen unmounts, but
 * the native stop path still needs to drain the microphone and inference jobs.
 */
internal class CaptionSessionController(
  context: android.content.Context,
  private val onCaption: (Map<String, Any?>) -> Unit,
  private val onStatus: (Map<String, Any?>) -> Unit,
) : AutoCloseable {
  companion object {
    private const val TAG = "MoonshineCaptions"
    private const val ARM64_ABI = "arm64-v8a"
    private const val STOP_WAIT_TIMEOUT_MS = 15_000L
  }

  private class Session(
    val id: String,
    microphone: LiveMicrophone,
  ) {
    val microphone = microphone
    val startedAtNanos = System.nanoTime()
    val stopFinished = CompletableDeferred<Unit>()

    var preparationJob: Job? = null
    var inferenceJob: Job? = null
    var cleanupJob: Job? = null
    var engine: MoonshineEngine? = null
    var preparationFailure: Throwable? = null
    var failureMessage: String? = null
    var errorEmitted = false
    var stopRequested = false
    var stopCompleted = false
    var automaticStopScheduled = false
    var nextSequence = 0L
    var lastText: String? = null
    var lastFinal = false
    var firstCaptionLogged = false
    var processedSamples = 0L
    var delayed = false
    var transcript: List<Map<String, Any>> = emptyList()
  }

  private val context = context.applicationContext
  private val lock = Any()
  private val eventLock = Any()
  private val state = CaptionSessionState()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var current: Session? = null
  private var closed = false
  private var closeJob: Job? = null
  private var lastResult: Pair<String, CaptionStopResult>? = null
  fun isActive(): Boolean = synchronized(lock) { current != null }

  /** Resolves after the model and microphone are ready for camera recording. */
  suspend fun start(sessionId: String) {
    require(sessionId.isNotBlank()) { "Caption session ID must not be empty" }
    ensureSupported(sessionId)

    val session: Session
    val preparation: Job
    synchronized(lock) {
      check(!closed) { "Live captions are unavailable because the module is closed" }
      when (state.start(sessionId)) {
        CaptionSessionState.StartResult.Duplicate -> {
          throw IllegalStateException("Caption session is already active: $sessionId")
        }
        CaptionSessionState.StartResult.Busy -> {
          throw IllegalStateException("Another caption session is already active")
        }
        CaptionSessionState.StartResult.Started -> Unit
      }

      session = Session(sessionId, LiveMicrophone(context))
      current = session
      preparation = scope.launch(start = CoroutineStart.LAZY) {
        prepare(session)
      }
      session.preparationJob = preparation
      // Publish PREPARING while the state lock is held. A lifecycle stop that
      // wins after this point must therefore be observed after this event.
      emitStatusMessage(session.id, "preparing")
    }

    preparation.start()
    preparation.join()

    val outcome = synchronized(lock) {
      session.preparationFailure to session.stopRequested
    }
    outcome.first?.let { throw it }
    check(!outcome.second) { "Caption session stopped during preparation" }
    check(synchronized(lock) { state.isActive(session.id) }) {
      "Caption session is no longer active"
    }
  }

  /** Stops the requested session and waits until final events have been sent. */
  suspend fun stop(sessionId: String): List<Map<String, Any>> {
    require(sessionId.isNotBlank()) { "Caption session ID must not be empty" }

    val session: Session
    val shouldStop: Boolean
    synchronized(lock) {
      when (state.stop(sessionId)) {
        CaptionSessionState.StopResult.AlreadyStopped -> return lastResult?.takeIf { it.first == sessionId }?.second?.transcriptOrThrow() ?: emptyList()
        CaptionSessionState.StopResult.Stale -> {
          throw IllegalArgumentException("Stale caption session: $sessionId")
        }
        CaptionSessionState.StopResult.AlreadyStopping -> {
          session = current ?: throw IllegalStateException("Caption session cleanup is unavailable")
          shouldStop = false
        }
        CaptionSessionState.StopResult.Stopping -> {
          session = current ?: throw IllegalStateException("Caption session is unavailable")
          session.stopRequested = true
          // Keep the state transition and its event atomic with preparation.
          emitStatusMessage(session.id, "stopping")
          shouldStop = true
        }
      }
    }

    if (!shouldStop) {
      awaitStop(session)
      return CaptionStopResult(session.transcript, session.failureMessage).transcriptOrThrow()
    }

    session.microphone.requestStop()
    session.preparationJob?.cancel()
    scheduleCleanup(session)
    awaitStop(session)
    return CaptionStopResult(session.transcript, session.failureMessage).transcriptOrThrow()
  }

  /** Called by Expo activity lifecycle callbacks. */
  fun requestStopFromLifecycle(reason: String) {
    val sessionId = synchronized(lock) { current?.id }
    if (sessionId == null) return
    scope.launch {
      runCatching { stop(sessionId) }
        .onFailure { Log.w(TAG, "lifecycle_stop_failed session=$sessionId reason=$reason", it) }
    }
  }

  override fun close() {
    val sessionId: String?
    synchronized(lock) {
      if (closed) return
      closed = true
      sessionId = current?.id
    }

    if (sessionId == null) {
      scope.cancel()
      return
    }

    closeJob = scope.launch {
      try {
        runCatching { stop(sessionId) }
          .onFailure { Log.w(TAG, "module_close_stop_failed session=$sessionId", it) }
        synchronized(lock) { current?.takeIf { it.id == sessionId }?.cleanupJob }
          ?.join()
      } finally {
        scope.cancel()
      }
    }
  }

  private suspend fun prepare(session: Session) {
    var preparedEngine: MoonshineEngine? = null
    var engineInstalled = false
    var microphoneStarted = false
    try {
      val directory = MoonshineModel.directory(context)
      ensurePreparationCanContinue(session)

      preparedEngine = MoonshineEngine(directory)
      ensurePreparationCanContinue(session)

      check(session.microphone.start()) {
        session.microphone.failure ?: "Could not start microphone"
      }
      microphoneStarted = true
      ensurePreparationCanContinue(session)

      val engine = preparedEngine ?: error("Moonshine engine was not created")
      val inference = scope.launch(start = CoroutineStart.LAZY) {
        runInference(session, engine)
      }
      val accepted = synchronized(lock) {
        if (session.stopRequested || !state.isActive(session.id)) {
          false
        } else if (!state.markListening(session.id)) {
          false
        } else {
          session.engine = engine
          session.inferenceJob = inference
          engineInstalled = true
          // Starting the sibling job under the state lock closes the race in
          // which stop cancels preparation after acceptance but before start.
          check(inference.start()) { "Could not start caption inference" }
          true
        }
      }
      if (!accepted) {
        inference.cancel()
        return
      }

      emitStatusIfPhase(session, CaptionSessionState.Phase.LISTENING, "listening")
      preparedEngine = null
    } catch (cancelled: CancellationException) {
      // A normal stop cancels preparation. Its stop job owns the final state
      // transition, so cancellation here must not publish a second error.
      if (!synchronized(lock) { session.stopRequested }) {
        recordFailure(session, cancelled, preparation = true, emitImmediately = true)
        scheduleAutomaticStop(session)
      }
      throw cancelled
    } catch (failure: Throwable) {
      recordFailure(session, failure, preparation = true, emitImmediately = true)
      session.microphone.requestStop()
      scheduleAutomaticStop(session)
    } finally {
      if (preparedEngine != null && !engineInstalled) {
        runCatching { preparedEngine?.close() }
      }
      if (microphoneStarted && !engineInstalled) {
        session.microphone.requestStop()
        withContext(NonCancellable) { session.microphone.awaitStopped() }
      }
    }
  }

  private suspend fun runInference(session: Session, engine: MoonshineEngine) {
    var cancelled = false
    try {
      for (samples in session.microphone.chunks()) {
        engine.addAudio(samples)
        session.processedSamples += samples.size
        val lagMs = ((session.microphone.capturedSamples - session.processedSamples).coerceAtLeast(0) * 1000 / LiveMicrophone.SAMPLE_RATE)
        val delayed = recognitionDelayed(session.delayed, lagMs)
        val statusChanged = synchronized(lock) {
          if (session.stopRequested || !state.isActive(session.id) || delayed == session.delayed) {
            false
          } else {
            session.delayed = delayed
            // Hold the state lock through emission so stopping cannot be
            // observed before this already-accepted listening update.
            emitStatusMessage(session.id, if (session.delayed) "delayed" else "listening")
            true
          }
        }
        if (statusChanged) {
          Log.i(TAG, "processing_lag session=${session.id} lag_ms=$lagMs processor=CPU")
        }
        publishSnapshot(session, engine)
      }
    } catch (cancellation: CancellationException) {
      cancelled = true
      throw cancellation
    } catch (failure: Throwable) {
      recordFailure(session, failure, preparation = false, emitImmediately = true)
      session.microphone.requestStop()
    } finally {
      if (!cancelled) {
        runCatching { engine.finish() }
          .onFailure { failure ->
            recordFailure(session, failure, preparation = false, emitImmediately = true)
          }
        runCatching { publishSnapshot(session, engine, forceFinal = true) }
          .onFailure { failure ->
            recordFailure(session, failure, preparation = false, emitImmediately = true)
          }
      }
      session.microphone.failure?.let { message ->
        recordFailure(
          session,
          IllegalStateException(message),
          preparation = false,
          emitImmediately = true,
        )
      }
      session.transcript = engine.transcript().map { it.event() }
    }
  }

  private suspend fun finishStop(session: Session) {
    var cleanupFailure: Throwable? = null
    try {
      withContext(NonCancellable) {
        session.microphone.requestStop()
        session.preparationJob?.join()
        session.inferenceJob?.join()
        session.microphone.awaitStopped()
        val engine = synchronized(lock) {
          session.engine.also { session.engine = null }
        }
        runCatching { engine?.close() }
          .onFailure { failure -> cleanupFailure = failure }
      }
    } catch (failure: Throwable) {
      cleanupFailure = failure
    }

    cleanupFailure?.let {
      recordFailure(session, it, preparation = false, emitImmediately = true)
    }

    val shouldComplete = synchronized(lock) {
      if (session.stopCompleted) {
        false
      } else {
        session.stopCompleted = true
        lastResult = session.id to CaptionStopResult(session.transcript, session.failureMessage)
        state.finish(session.id)
        if (current === session) current = null
        // Keep stopped ahead of any subsequent session's preparing event.
        emitStatusMessage(session.id, "stopped")
        true
      }
    }
    if (!shouldComplete) return

    session.stopFinished.complete(Unit)
  }

  private fun scheduleCleanup(session: Session) {
    synchronized(lock) {
      if (session.cleanupJob == null) {
        session.cleanupJob = scope.launch {
          finishStop(session)
        }
      }
    }
  }

  private suspend fun awaitStop(session: Session) {
    try {
      withTimeout(STOP_WAIT_TIMEOUT_MS) { session.stopFinished.await() }
    } catch (_: TimeoutCancellationException) {
      val message = "Caption cleanup is still running; try stopping again shortly"
      recordFailure(session, IllegalStateException(message), preparation = false, emitImmediately = true)
      throw IllegalStateException(message)
    }
  }

  private fun publishSnapshot(
    session: Session,
    engine: MoonshineEngine,
    forceFinal: Boolean = false,
  ) {
    val snapshot = engine.snapshot(forceFinal)
    if (snapshot.text.isEmpty()) return

    val event: Map<String, Any?>?
    val sequence: Long
    val firstCaption: Boolean
    synchronized(lock) {
      if (session.stopCompleted ||
        (snapshot.text == session.lastText && snapshot.isFinal == session.lastFinal)
      ) {
        return
      }
      session.lastText = snapshot.text
      session.lastFinal = snapshot.isFinal
      session.nextSequence += 1
      sequence = session.nextSequence
      firstCaption = !session.firstCaptionLogged
      session.firstCaptionLogged = true
      event = mapOf(
        "sessionId" to session.id,
        "text" to snapshot.text,
        "isFinal" to snapshot.isFinal,
        "sequence" to sequence,
        "segments" to snapshot.segments.map { it.event() },
      )
    }

    if (firstCaption) {
      val latencyMs = ((System.nanoTime() - session.startedAtNanos) / 1_000_000L).coerceAtLeast(0)
      Log.i(TAG, "first_partial session=${session.id} latency_ms=$latencyMs sequence=$sequence")
    }
    emitCaption(event)
  }

  private fun ensurePreparationCanContinue(session: Session) {
    if (synchronized(lock) { session.stopRequested || !state.isActive(session.id) }) {
      throw CancellationException("Caption session stopped during preparation")
    }
  }

  private fun emitStatusIfPhase(
    session: Session,
    expectedPhase: CaptionSessionState.Phase,
    status: String,
    message: String? = null,
  ) {
    synchronized(lock) {
      if (!canEmitSessionStatus(
          active = state.isActive(session.id),
          stopRequested = session.stopRequested,
          phase = state.phase(),
          expectedPhase = expectedPhase,
        )
      ) {
        return
      }
      // The check and callback are one critical section. A concurrent stop
      // cannot publish stopping before this event after it has been accepted.
      emitStatusMessage(session.id, status, message)
    }
  }

  private fun ensureSupported(sessionId: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      val message = "Moonshine live captions require Android API 26 or newer"
      emitStatusMessage(sessionId, "error", message)
      throw UnsupportedOperationException(message)
    }
    if (!Build.SUPPORTED_ABIS.any { it == ARM64_ABI }) {
      val message = "Moonshine live captions require an arm64-v8a device"
      emitStatusMessage(sessionId, "error", message)
      throw UnsupportedOperationException(message)
    }
  }

  private fun recordFailure(
    session: Session,
    failure: Throwable,
    preparation: Boolean,
    emitImmediately: Boolean,
  ) {
    val message = failure.message?.takeIf { it.isNotBlank() }
      ?: failure::class.java.simpleName
    val shouldEmit = synchronized(lock) {
      if (preparation && session.preparationFailure == null) {
        session.preparationFailure = failure
      }
      if (session.failureMessage == null) session.failureMessage = message
      if (emitImmediately && !session.errorEmitted) {
        session.errorEmitted = true
        true
      } else {
        false
      }
    }
    if (shouldEmit) emitStatus(session, "error", message)
  }

  private fun scheduleAutomaticStop(session: Session) {
    val schedule = synchronized(lock) {
      if (session.stopRequested || session.stopCompleted || session.automaticStopScheduled) {
        false
      } else {
        session.stopRequested = true
        session.automaticStopScheduled = true
        true
      }
    }
    if (!schedule) return
    session.microphone.requestStop()
    scope.launch {
      runCatching { stop(session.id) }
        .onFailure { Log.w(TAG, "automatic_stop_failed session=${session.id}", it) }
    }
  }

  private fun emitStatus(session: Session, status: String, message: String? = null) {
    emitStatusMessage(session.id, status, message)
  }

  private fun emitStatusMessage(sessionId: String, status: String, message: String? = null) {
    val event = if (message == null) {
      mapOf<String, Any?>("sessionId" to sessionId, "status" to status, "processor" to "cpu")
    } else {
      mapOf<String, Any?>("sessionId" to sessionId, "status" to status, "message" to message, "processor" to "cpu")
    }
    synchronized(eventLock) {
      runCatching { onStatus(event) }
    }
  }

  private fun emitCaption(event: Map<String, Any?>?) {
    if (event == null) return
    synchronized(eventLock) {
      runCatching { onCaption(event) }
    }
  }
}

internal fun canEmitSessionStatus(
  active: Boolean,
  stopRequested: Boolean,
  phase: CaptionSessionState.Phase,
  expectedPhase: CaptionSessionState.Phase,
): Boolean = active && !stopRequested && phase == expectedPhase
