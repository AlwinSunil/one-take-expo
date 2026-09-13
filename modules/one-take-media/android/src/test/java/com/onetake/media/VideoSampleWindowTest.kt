package com.onetake.media

import org.junit.Assert.*
import org.junit.Test

class VideoSampleWindowTest {
  @Test fun rejectsActualPickupTailAfterFinalVideoFrame() {
    val tail = sequenceOf(4_297_133L, 4_330_444L, 4_363_756L)
    assertFalse(videoWindowHasSample(tail, 4_377_000L, 4_397_000L))
  }
  @Test fun acceptsShortCutContainingOneFrame() {
    assertTrue(videoWindowHasSample(sequenceOf(4_330_444L, 4_363_756L), 4_360_000L, 4_380_000L))
  }
  @Test fun searchesPastOutsideReferenceForInCutReorderedFrame() {
    assertTrue(videoWindowHasSample(sequenceOf(4_400_000L, 4_380_000L), 4_377_000L, 4_397_000L))
  }
  @Test fun endIsExclusiveAndScanStopsAfterReorderingBudget() {
    assertFalse(videoWindowHasSample(sequenceOf(4_397_000L), 4_377_000L, 4_397_000L))
    var consumed = 0
    val outside = generateSequence { consumed++; 4_400_000L }
    assertFalse(videoWindowHasSample(outside, 4_377_000L, 4_397_000L))
    assertEquals(32, consumed)
  }
}
