package com.onetake.media

import kotlin.math.max
import kotlin.math.min

/** A source interval expressed in seconds relative to the original file. */
internal data class SourceCut(val t0: Double, val t1: Double)

/** A caption interval expressed in seconds relative to the original file. */
internal data class SourceCaption(val t0: Double, val t1: Double, val text: String)

/** A caption interval expressed in microseconds on the concatenated output. */
internal data class MappedCaption(val startUs: Long, val endUs: Long, val text: String)

/**
 * Validates explicit source cuts and maps source-relative captions to output
 * time.  The order supplied by the editor is retained deliberately.  A cut
 * is an explicit edit decision, never an ASR timing suggestion.
 */
internal object MediaExportTimeline {
  const val MAX_SOURCE_SECONDS = 24 * 60 * 60.0
  const val MAX_CUTS = 100
  const val MAX_CAPTIONS = 10_000
  const val MAX_TEXT_LENGTH = 2_000

  fun validateCuts(cuts: List<SourceCut>): List<SourceCut> {
    require(cuts.size <= MAX_CUTS) { "Too many export cuts" }
    return cuts.mapIndexed { index, cut ->
      validateInterval(cut.t0, cut.t1, "cut", index)
      cuts.take(index).forEachIndexed { priorIndex, prior ->
        require(cut.t1 <= prior.t0 || cut.t0 >= prior.t1) {
          "Export cuts overlap at index $index (with index $priorIndex)"
        }
      }
      cut
    }
  }

  fun validateCaptions(captions: List<SourceCaption>): List<SourceCaption> {
    require(captions.size <= MAX_CAPTIONS) { "Too many export captions" }
    val sorted = captions.sortedWith(compareBy<SourceCaption> { it.t0 }.thenBy { it.t1 })
    var previous: SourceCaption? = null
    sorted.forEachIndexed { index, caption ->
      validateInterval(caption.t0, caption.t1, "caption", index)
      require(caption.text.isNotBlank()) { "Caption text is blank at index $index" }
      require(caption.text.length <= MAX_TEXT_LENGTH) {
        "Caption text is too long at index $index"
      }
      previous?.let { prior ->
        require(caption.t0 >= prior.t1) {
          "Export captions overlap at index $index"
        }
      }
      previous = caption
    }
    return sorted
  }

  /**
   * Maps each caption intersection into the concatenated timeline.  A caption
   * crossing a removed gap is split at the cut boundary, which keeps text and
   * audio aligned without pretending the gap was present in the output.
   */
  fun mapCaptions(
    captions: List<SourceCaption>,
    cuts: List<SourceCut>,
  ): List<MappedCaption> {
    val sourceCaptions = validateCaptions(captions)
    val sourceCuts = validateCuts(cuts)
    if (sourceCaptions.isEmpty()) return emptyList()

    if (sourceCuts.isEmpty()) {
      return sourceCaptions.map { caption ->
        MappedCaption(toMicros(caption.t0), toMicros(caption.t1), caption.text)
      }
    }

    val mapped = ArrayList<MappedCaption>()
    var outputOffsetUs = 0L
    sourceCuts.forEach { cut ->
      // Media3 clipping positions are millisecond based. Use those same
      // boundaries for overlay mapping so a sub-millisecond input rounding
      // cannot make captions drift from the retained audio/video.
      val cutStartUs = toMillis(cut.t0) * 1_000L
      val cutEndUs = toMillis(cut.t1) * 1_000L
      sourceCaptions.forEach { caption ->
        val intersectionStartUs = max(cutStartUs, toMicros(caption.t0))
        val intersectionEndUs = min(cutEndUs, toMicros(caption.t1))
        if (intersectionEndUs > intersectionStartUs) {
          mapped += MappedCaption(
            startUs = outputOffsetUs + (intersectionStartUs - cutStartUs),
            endUs = outputOffsetUs + (intersectionEndUs - cutStartUs),
            text = caption.text,
          )
        }
      }
      outputOffsetUs = checkedAdd(outputOffsetUs, cutEndUs - cutStartUs)
    }
    return mapped
  }

  fun toMicros(seconds: Double): Long {
    require(seconds.isFinite() && seconds >= 0.0 && seconds <= MAX_SOURCE_SECONDS) {
      "Media timestamps must be finite values between 0 and 24 hours"
    }
    val micros = (seconds * 1_000_000.0).toLong()
    require(micros >= 0L) { "Media timestamp is out of range" }
    return micros
  }

  private fun validateInterval(t0: Double, t1: Double, label: String, index: Int) {
    require(t0.isFinite() && t1.isFinite() && t0 >= 0.0 && t1 > t0) {
      "Invalid $label interval at index $index"
    }
    require(t1 <= MAX_SOURCE_SECONDS) {
      "$label interval exceeds the 24 hour source limit at index $index"
    }
    require(toMicros(t1) > toMicros(t0)) {
      "$label interval is shorter than one microsecond at index $index"
    }
    require(toMillis(t1) > toMillis(t0)) {
      "$label interval is shorter than one millisecond at index $index"
    }
  }

  fun toMillis(seconds: Double): Long = (toMicros(seconds) / 1_000L)

  private fun checkedAdd(left: Long, right: Long): Long {
    require(right >= 0L && Long.MAX_VALUE - left >= right) {
      "Export timeline is too long"
    }
    return left + right
  }
}
