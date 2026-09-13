package com.onetake.captions

import kotlin.math.min

/** The two labels retained by the Uhm review detector. */
internal enum class AcousticFillerLabel {
  UM,
  UH,
}

/** One source-owned 20 ms model frame. A null label means no retained filler. */
internal data class AcousticFillerFrame(
  val startSample: Int,
  val label: AcousticFillerLabel?,
  val score: Double,
)

/** A contiguous acoustic observation, still only a review marker. */
internal data class AcousticFillerEvent(
  val startSample: Int,
  val endSample: Int,
  val label: AcousticFillerLabel,
  val score: Double,
)

/**
 * Converts source-owned model frames into review events.
 *
 * The native runner owns each source frame exactly once. This class deliberately
 * merges only adjacent source frames with the same label, so overlapping model
 * windows cannot inflate an event or bridge a gap. The final source frame is
 * clamped to the decoded duration rather than to model padding.
 */
internal object AcousticFillerSegmentation {
  const val FRAME_SAMPLES = 320

  fun segment(frames: List<AcousticFillerFrame>, durationSamples: Int): List<AcousticFillerEvent> {
    require(durationSamples > 0) { "Acoustic filler duration must be positive" }

    val events = ArrayList<AcousticFillerEvent>()
    var active: AcousticFillerEvent? = null
    for (frame in frames) {
      require(frame.startSample >= 0) { "Acoustic filler frame start must be non-negative" }
      require(frame.score.isFinite() && frame.score in 0.0..1.0) {
        "Acoustic filler frame score must be between zero and one"
      }

      val start = frame.startSample
      val end = min(durationSamples, start + FRAME_SAMPLES)
      if (frame.label == null || start >= durationSamples || end <= start) {
        active?.let { events += it }
        active = null
        continue
      }

      val current = active
      if (current != null && current.label == frame.label && current.endSample == start) {
        active = current.copy(
          endSample = end,
          score = min(current.score, frame.score),
        )
      } else {
        current?.let { events += it }
        active = AcousticFillerEvent(start, end, frame.label, frame.score)
      }
    }
    active?.let { events += it }
    return events
  }
}
