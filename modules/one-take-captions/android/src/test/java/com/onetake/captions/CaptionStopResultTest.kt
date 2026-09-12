package com.onetake.captions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

class CaptionStopResultTest {
  @Test fun `successful stop returns the final transcript`() {
    val transcript = listOf(mapOf<String, Any>("text" to "A clean line"))
    assertSame(transcript, CaptionStopResult(transcript, null).transcriptOrThrow())
  }

  @Test fun `failed session cannot look successful before status events render or on repeated stop`() {
    val transcript = listOf(mapOf<String, Any>("text" to "Partial line"))
    val terminal = CaptionStopResult(transcript, "Microphone stopped producing samples")
    repeat(2) {
      try {
        terminal.transcriptOrThrow()
        fail("A failed session must reject every stop result")
      } catch (error: IllegalStateException) {
        assertEquals("Microphone stopped producing samples", error.message)
      }
    }
    assertSame(transcript, terminal.transcript)
  }
}
