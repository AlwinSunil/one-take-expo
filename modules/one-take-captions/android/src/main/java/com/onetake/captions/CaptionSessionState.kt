package com.onetake.captions

/**
 * Small synchronized state machine used by the native module.
 *
 * Keeping the session identifier in the state machine makes a late stop from a
 * previous React render harmless when a new recording is already active.
 */
internal class CaptionSessionState {
  enum class Phase {
    IDLE,
    PREPARING,
    LISTENING,
    STOPPING,
  }

  enum class StartResult {
    Started,
    Duplicate,
    Busy,
  }

  enum class StopResult {
    Stopping,
    AlreadyStopping,
    AlreadyStopped,
    Stale,
  }

  private var activeSessionId: String? = null
  private var lastStoppedSessionId: String? = null
  private var phase = Phase.IDLE

  @Synchronized
  fun start(sessionId: String): StartResult {
    val active = activeSessionId
    if (active != null) {
      return if (active == sessionId) StartResult.Duplicate else StartResult.Busy
    }
    activeSessionId = sessionId
    phase = Phase.PREPARING
    return StartResult.Started
  }

  @Synchronized
  fun markListening(sessionId: String): Boolean {
    if (activeSessionId != sessionId || phase != Phase.PREPARING) {
      return false
    }
    phase = Phase.LISTENING
    return true
  }

  @Synchronized
  fun stop(sessionId: String): StopResult {
    if (activeSessionId == null) {
      return if (lastStoppedSessionId == sessionId) {
        StopResult.AlreadyStopped
      } else {
        StopResult.Stale
      }
    }
    if (activeSessionId != sessionId) {
      return StopResult.Stale
    }
    if (phase == Phase.STOPPING) {
      return StopResult.AlreadyStopping
    }
    phase = Phase.STOPPING
    return StopResult.Stopping
  }

  @Synchronized
  fun finish(sessionId: String): Boolean {
    if (activeSessionId != sessionId) {
      return false
    }
    activeSessionId = null
    lastStoppedSessionId = sessionId
    phase = Phase.IDLE
    return true
  }

  @Synchronized
  fun isActive(sessionId: String): Boolean = activeSessionId == sessionId

  @Synchronized
  fun activeSessionId(): String? = activeSessionId

  @Synchronized
  fun phase(): Phase = phase
}
