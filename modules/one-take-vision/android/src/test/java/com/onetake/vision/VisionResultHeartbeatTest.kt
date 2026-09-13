package com.onetake.vision

import org.junit.Assert.*
import org.junit.Test

class VisionResultHeartbeatTest {
  @Test fun ongoingThrottledDeliveryDoesNotResetFaceStability() {
    var time = 300L
    val heartbeat = VisionResultHeartbeat({ time })
    heartbeat.received()
    for (delivery in listOf(1100L, 1900L, 2700L)) {
      time = delivery
      assertFalse(heartbeat.stale())
      heartbeat.received()
    }
    time = 3699L
    assertFalse(heartbeat.stale())
    time = 3700L
    assertTrue(heartbeat.stale())
  }
  @Test fun aLateInferenceResultStartsANewAvailabilityWindow() {
    var time = 0L
    val heartbeat = VisionResultHeartbeat({ time })
    assertFalse(heartbeat.stale())
    // A result may have been captured earlier; receipt, not capture, is this heartbeat.
    time = 1500L
    heartbeat.received()
    time = 2300L
    assertFalse(heartbeat.stale())
    time = 2500L
    assertTrue(heartbeat.stale())
  }
}
