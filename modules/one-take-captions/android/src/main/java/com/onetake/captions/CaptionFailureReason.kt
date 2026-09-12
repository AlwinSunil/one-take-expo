package com.onetake.captions

/**
 * Names why recognition became unavailable so JavaScript can say something
 * specific and decide whether another attempt is worth offering.
 *
 * The constants match `CaptionFailureReason` in
 * `modules/one-take-captions/index.ts`. Classification is message based because
 * the failures originate in several unrelated places - asset staging, the
 * checksum guard, AudioRecord and the Moonshine runtime - and wrapping every
 * one of them in a dedicated exception type would be a much larger change to
 * an already device-verified path.
 */
internal object CaptionFailureReason {
  const val MODEL_MISSING = "model-missing"
  const val MODEL_CORRUPT = "model-corrupt"
  const val INITIALIZATION_FAILED = "initialization-failed"
  const val UNSUPPORTED_DEVICE = "unsupported-device"
  const val PERMISSION_DENIED = "permission-denied"
  const val UNKNOWN = "unknown"

  /**
   * Interruptions the take survives. The next start clears them.
   *
   * `AUDIO_FOCUS_LOST` and `AUDIO_ROUTE_CHANGED` complete the wire contract
   * with the TypeScript side; no `AudioManager` listener raises them yet, so
   * only `LIFECYCLE_INTERRUPTED` is emitted today.
   */
  const val AUDIO_FOCUS_LOST = "audio-focus-lost"
  const val AUDIO_ROUTE_CHANGED = "audio-route-changed"
  const val LIFECYCLE_INTERRUPTED = "lifecycle-interrupted"

  /** Ordered most specific first: a checksum mismatch also names the model. */
  private val patterns = listOf(
    Regex("checksum mismatch|hash mismatch|corrupt") to MODEL_CORRUPT,
    Regex("model asset .* is unavailable|prepare_moonshine|install caption model|model directory") to MODEL_MISSING,
    Regex("permission") to PERMISSION_DENIED,
    // Anchored to the exact device-support sentences this module emits. A
    // bare "unsupported" would also match an unsupported PCM encoding or
    // channel count, which are retryable audio failures and must not tell
    // the user their phone cannot run the model.
    Regex("arm64|android api 26 or newer|android 8 or newer") to UNSUPPORTED_DEVICE,
  )

  fun classify(message: String?): String {
    val text = message?.lowercase()?.takeIf { it.isNotBlank() } ?: return UNKNOWN
    return patterns.firstOrNull { (pattern, _) -> pattern.containsMatchIn(text) }?.second
      ?: INITIALIZATION_FAILED
  }
}
