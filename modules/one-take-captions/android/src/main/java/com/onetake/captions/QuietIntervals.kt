package com.onetake.captions

/** Conservative low-energy candidates, never a claim that speech is absent. */
internal object QuietIntervals {
  fun find(audio: FloatArray): List<Map<String, Double>> {
    val result = mutableListOf<Map<String, Double>>()
    var quietStart: Int? = null
    var offset = 0
    while (offset < audio.size) {
      val end = (offset + 320).coerceAtMost(audio.size)
      var energy = 0.0
      for (i in offset until end) energy += audio[i].toDouble() * audio[i]
      val quiet = energy / (end - offset) < 0.00001 // About -50 dBFS RMS.
      if (quiet && quietStart == null) quietStart = offset
      if (!quiet && quietStart != null) {
        append(result, quietStart, offset)
        quietStart = null
      }
      offset = end
    }
    quietStart?.let { append(result, it, audio.size) }
    return result
  }

  private fun append(result: MutableList<Map<String, Double>>, start: Int, end: Int) {
    if (end - start >= 16_000) result += mapOf("t0" to start / 16_000.0, "t1" to end / 16_000.0)
  }
}
