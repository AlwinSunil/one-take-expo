package com.onetake.captions

import org.junit.Assert.assertEquals
import org.junit.Test

class QuietIntervalsTest {
  @Test fun preservesSpeechAndIgnoresBriefPauses() {
    val audio = FloatArray(64_000) { if (it in 16_000 until 48_000) 0f else 0.1f }
    assertEquals(listOf(mapOf("t0" to 1.0, "t1" to 3.0)), QuietIntervals.find(audio))
    assertEquals(emptyList<Map<String, Double>>(), QuietIntervals.find(FloatArray(8_000)))
  }
}
