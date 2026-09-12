package com.onetake.captions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptionSessionStateTest {
  @Test
  fun `a stale stop cannot stop a newer session`() {
    val state = CaptionSessionState()

    assertEquals(CaptionSessionState.StartResult.Started, state.start("first"))
    assertTrue(state.markListening("first"))
    assertEquals(CaptionSessionState.StopResult.Stale, state.stop("other"))
    assertTrue(state.isActive("first"))

    assertEquals(CaptionSessionState.StopResult.Stopping, state.stop("first"))
    assertFalse(state.markListening("first"))
    assertTrue(state.finish("first"))
    assertEquals(CaptionSessionState.StartResult.Started, state.start("second"))
    assertEquals(CaptionSessionState.StopResult.Stale, state.stop("first"))
    assertTrue(state.isActive("second"))
  }

  @Test
  fun `duplicate starts and repeated stop are deterministic`() {
    val state = CaptionSessionState()

    assertEquals(CaptionSessionState.StartResult.Started, state.start("session"))
    assertEquals(CaptionSessionState.StartResult.Duplicate, state.start("session"))
    assertEquals(CaptionSessionState.StartResult.Busy, state.start("another"))

    assertEquals(CaptionSessionState.StopResult.Stopping, state.stop("session"))
    assertEquals(CaptionSessionState.StopResult.AlreadyStopping, state.stop("session"))
    assertTrue(state.finish("session"))
    assertEquals(CaptionSessionState.StopResult.AlreadyStopped, state.stop("session"))
    assertFalse(state.isActive("session"))
  }
}
