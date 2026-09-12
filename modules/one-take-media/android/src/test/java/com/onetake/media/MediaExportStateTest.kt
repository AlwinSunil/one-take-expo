package com.onetake.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaExportStateTest {
  @Test
  fun cancellationIsIdempotentAndNeverReopensACompletedJob() {
    assertEquals(MediaExportStatus.CANCELLED, MediaExportState.cancel(MediaExportStatus.QUEUED))
    assertEquals(MediaExportStatus.CANCELLED, MediaExportState.cancel(MediaExportStatus.RUNNING))
    assertEquals(MediaExportStatus.CANCELLED, MediaExportState.cancel(MediaExportStatus.CANCELLED))
    assertEquals(MediaExportStatus.COMPLETED, MediaExportState.cancel(MediaExportStatus.COMPLETED))
  }

  @Test
  fun retryIsOnlyOfferedForRecoverableTerminalStates() {
    assertTrue(MediaExportState.canRetry(MediaExportStatus.CANCELLED))
    assertTrue(MediaExportState.canRetry(MediaExportStatus.FAILED))
    assertTrue(MediaExportState.canRetry(MediaExportStatus.INTERRUPTED))
    assertFalse(MediaExportState.canRetry(MediaExportStatus.QUEUED))
    assertFalse(MediaExportState.canRetry(MediaExportStatus.RUNNING))
    assertFalse(MediaExportState.canRetry(MediaExportStatus.COMPLETED))
  }
}
