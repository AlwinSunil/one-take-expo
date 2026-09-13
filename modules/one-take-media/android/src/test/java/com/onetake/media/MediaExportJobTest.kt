package com.onetake.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaExportJobTest {
  @Test
  fun timelineRevisionSurvivesRequestCopy() {
    val request = markedRequest(42L)
    assertEquals(42L, request.timelineRevision)
    assertEquals(42L, request.copy().timelineRevision)
  }

  @Test
  fun markedRequestsRequireExplicitSegments() {
    assertRevisionError {
      MediaExportRequest(
        id = "revision-test",
        sourceUri = "file:///source.mp4",
        cuts = emptyList(),
        captions = emptyList(),
        segments = emptyList(),
        timelineRevision = 1L,
      )
    }
  }

  @Test
  fun legacyEmptyCutsAndSegmentsRemainCompatible() {
    val request = MediaExportRequest(
      id = "legacy-test",
      sourceUri = "file:///source.mp4",
      cuts = emptyList(),
      captions = emptyList(),
      segments = emptyList(),
    )
    assertTrue(request.segments.isEmpty())
    assertEquals(null, request.timelineRevision)
  }

  @Test
  fun timelineRevisionMustBeAJavaScriptSafeInteger() {
    assertRevisionError {
      markedRequest(-1L)
    }
    assertRevisionError {
      markedRequest(MAX_SAFE_TIMELINE_REVISION + 1L)
    }
  }

  private fun markedRequest(revision: Long): MediaExportRequest = MediaExportRequest(
    id = "revision-test",
    sourceUri = "file:///source.mp4",
    cuts = emptyList(),
    captions = emptyList(),
    segments = listOf(segment()),
    timelineRevision = revision,
  )

  private fun segment() = MediaSourceSegment(
    uri = "file:///source.mp4",
    cut = SourceCut(0.0, 1.0),
    captions = emptyList(),
  )

  private fun assertRevisionError(block: () -> Unit) {
    try {
      block()
      throw AssertionError("Expected an invalid timelineRevision request")
    } catch (failure: IllegalArgumentException) {
      assertTrue(
        "Unexpected error: ${failure.message}",
        failure.message?.contains("timelineRevision") == true,
      )
    }
  }
}
