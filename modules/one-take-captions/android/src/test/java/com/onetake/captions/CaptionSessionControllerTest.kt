package com.onetake.captions

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptionSessionControllerTest {
  @Test
  fun `preparation and listening status are suppressed after stop`() {
    assertTrue(
      canEmitSessionStatus(
        active = true,
        stopRequested = false,
        phase = CaptionSessionState.Phase.PREPARING,
        expectedPhase = CaptionSessionState.Phase.PREPARING,
      ),
    )
    assertTrue(
      canEmitSessionStatus(
        active = true,
        stopRequested = false,
        phase = CaptionSessionState.Phase.LISTENING,
        expectedPhase = CaptionSessionState.Phase.LISTENING,
      ),
    )
    assertFalse(
      canEmitSessionStatus(
        active = true,
        stopRequested = true,
        phase = CaptionSessionState.Phase.LISTENING,
        expectedPhase = CaptionSessionState.Phase.LISTENING,
      ),
    )
    assertFalse(
      canEmitSessionStatus(
        active = true,
        stopRequested = false,
        phase = CaptionSessionState.Phase.STOPPING,
        expectedPhase = CaptionSessionState.Phase.LISTENING,
      ),
    )
    assertFalse(
      canEmitSessionStatus(
        active = false,
        stopRequested = false,
        phase = CaptionSessionState.Phase.PREPARING,
        expectedPhase = CaptionSessionState.Phase.PREPARING,
      ),
    )
  }
}
