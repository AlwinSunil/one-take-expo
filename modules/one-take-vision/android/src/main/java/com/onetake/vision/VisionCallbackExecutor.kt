package com.onetake.vision

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * Keeps a completed ML Kit task from surfacing a rejected callback after the
 * analyzer executor has been closed.
 *
 * ML Kit may dispatch cancellation or completion listeners asynchronously
 * after FaceDetector.close().  The delegate is intentionally still strict
 * while the analyzer is open, so unrelated executor failures are not hidden.
 */
internal class VisionCallbackExecutor(
  private val delegate: Executor,
  private val isClosed: () -> Boolean,
) : Executor {
  override fun execute(command: Runnable) {
    try {
      delegate.execute(command)
    } catch (failure: RejectedExecutionException) {
      if (!isClosed()) {
        throw failure
      }
      // The analyzer's success/failure listeners guard their user-facing work
      // with closed, while the completion listener still needs to close the
      // ImageProxy. Run that cleanup inline when the callback executor has
      // already terminated, and do not surface a late listener exception.
      runCatching { command.run() }
    }
  }
}
