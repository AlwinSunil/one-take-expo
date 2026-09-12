package com.onetake.media

import org.junit.Assert.*
import org.junit.Test

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DecodeAheadBoundaryTest {
  @Test fun retainsTrailingBFramesAfterOutsideReferenceWithoutExtendingCut() {
    val boundary = DecodeAheadBoundary(0, 4_000_000)
    val compressed = listOf(3_900_000L, 3_833_333L, 3_866_667L, 4_000_000L, 3_933_333L, 3_966_667L, 4_100_000L)
    assertEquals(listOf(3_900_000L, 3_833_333L, 3_866_667L, -1L, 3_933_333L, 3_966_667L, -1L), compressed.map { boundary.timestamp(it, true) })
    assertFalse(boundary.ended())
  }
  @Test fun boundsReadAheadAndPeekingDoesNotConsumeBudget() {
    val boundary = DecodeAheadBoundary(8_000_000, 12_000_000)
    repeat(100) { assertEquals(7_999_999L, boundary.timestamp(12_000_000, false)) }
    assertFalse(boundary.ended())
    repeat(31) { boundary.timestamp(12_000_000, true) }
    assertFalse(boundary.ended())
    boundary.timestamp(12_000_000, true)
    assertTrue(boundary.ended())
    boundary.reset()
    assertFalse(boundary.ended())
  }
  @Test fun partialBufferingKeepsLoadingUntilReferencesDrainAndPreservesActualEos() {
    val boundary = DecodeAheadBoundary(0, 4_000_000)
    assertEquals(3_999_999L, decodeAheadLoadPosition(4_100_000, 4_000_000, !boundary.ended()))
    assertEquals(3_000_000L, decodeAheadLoadPosition(3_000_000, 4_000_000, !boundary.ended()))
    assertEquals(Long.MIN_VALUE, decodeAheadLoadPosition(Long.MIN_VALUE, 4_000_000, !boundary.ended()))
    boundary.finish()
    assertEquals(4_100_000L, decodeAheadLoadPosition(4_100_000, 4_000_000, !boundary.ended()))
    boundary.reset()
    assertEquals(3_999_999L, decodeAheadLoadPosition(4_100_000, 4_000_000, !boundary.ended()))
  }
  @Test fun syntheticEndRemainsReadableWhenUnderlyingStreamIsNotReady() {
    val child = object : androidx.media3.exoplayer.source.SampleStream {
      override fun isReady() = false
      override fun maybeThrowError() {}
      override fun skipData(positionUs: Long) = 0
      override fun readData(holder: androidx.media3.exoplayer.FormatHolder, buffer: androidx.media3.decoder.DecoderInputBuffer, flags: Int): Int {
        buffer.timeUs = 4_100_000
        return androidx.media3.common.C.RESULT_BUFFER_READ
      }
    }
    val stream = DecodeAheadStream(child, 0, 4_000_000)
    val holder = androidx.media3.exoplayer.FormatHolder()
    val buffer = androidx.media3.decoder.DecoderInputBuffer(0)
    repeat(32) { stream.readData(holder, buffer, 0) }
    assertTrue(stream.isReady)
    assertEquals(androidx.media3.common.C.RESULT_BUFFER_READ, stream.readData(holder, buffer, 0))
    assertTrue(buffer.isEndOfStream)
    stream.reset()
    assertFalse(stream.isReady)
  }
}
