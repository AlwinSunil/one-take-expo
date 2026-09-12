package com.onetake.vision

/**
 * Small hysteresis tracker for the face-presence chip. ML Kit can legitimately
 * miss a frame while a creator moves; requiring consecutive observations keeps
 * that transient miss from flipping the visible state.
 */
internal class FacePresenceTracker(
  private val presentFramesRequired: Int = 2,
  private val absentFramesRequired: Int = 3,
  private val minimumStableMs: Long = 300L,
) {
  data class State(
    val facePresent: Boolean?,
    val stable: Boolean,
    val stableForMs: Long,
  )

  private var stablePresence: Boolean? = null
  private var candidatePresence: Boolean? = null
  private var candidateCount = 0
  private var candidateStartedAtMs: Long? = null
  private var stableStartedAtMs: Long? = null

  fun update(facePresent: Boolean, atMs: Long): State {
    if (candidatePresence != facePresent) {
      candidatePresence = facePresent
      candidateCount = 0
      candidateStartedAtMs = atMs
    }
    candidateCount += 1

    val required = if (facePresent) presentFramesRequired else absentFramesRequired
    val candidateAgeMs = atMs - (candidateStartedAtMs ?: atMs)
    if (candidateCount >= required
      && candidateAgeMs >= minimumStableMs
      && stablePresence != facePresent) {
      stablePresence = facePresent
      stableStartedAtMs = atMs
    }

    val stableSince = stableStartedAtMs
    val stableForMs = if (stableSince == null) 0L else (atMs - stableSince).coerceAtLeast(0L)
    return State(
      facePresent = stablePresence,
      stable = stablePresence != null,
      stableForMs = stableForMs,
    )
  }

  fun reset(): State {
    stablePresence = null
    candidatePresence = null
    candidateCount = 0
    candidateStartedAtMs = null
    stableStartedAtMs = null
    return State(facePresent = null, stable = false, stableForMs = 0L)
  }
}
