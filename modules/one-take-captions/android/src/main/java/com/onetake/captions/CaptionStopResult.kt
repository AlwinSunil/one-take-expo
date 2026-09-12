package com.onetake.captions

/** Terminal failure travels with stop, independently of UI event delivery. */
internal data class CaptionStopResult(
  val transcript: List<Map<String, Any>>,
  val failureMessage: String?,
) {
  fun transcriptOrThrow(): List<Map<String, Any>> {
    failureMessage?.let { throw IllegalStateException(it) }
    return transcript
  }
}
