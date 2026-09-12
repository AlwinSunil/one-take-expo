package com.onetake.captions

import org.junit.Assert.*
import org.junit.Test

class RecognitionLagTest {
  @Test fun delayedStateDoesNotFlickerWhileBacklogDrains() {
    assertFalse(recognitionDelayed(false, 999))
    assertTrue(recognitionDelayed(false, 1001))
    assertTrue(recognitionDelayed(true, 999))
    assertTrue(recognitionDelayed(true, 250))
    assertFalse(recognitionDelayed(true, 249))
  }
}
