package com.onetake.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MediaExportTimelineTest {
  @Test
  fun mapsCaptionsAcrossOrderedNonAdjacentCuts() {
    val mapped = MediaExportTimeline.mapCaptions(
      captions = listOf(
        SourceCaption(1.0, 6.0, "hello"),
        SourceCaption(8.0, 9.0, "again"),
      ),
      cuts = listOf(
        SourceCut(0.0, 2.0),
        SourceCut(5.0, 8.5),
      ),
    )

    assertEquals(
      listOf(
        MappedCaption(1_000_000L, 2_000_000L, "hello"),
        MappedCaption(2_000_000L, 3_000_000L, "hello"),
        MappedCaption(5_000_000L, 5_500_000L, "again"),
      ),
      mapped,
    )
  }

  @Test
  fun rejectsOverlappingCutsButPreservesExplicitOutputOrder() {
    assertThrows(IllegalArgumentException::class.java) {
      MediaExportTimeline.validateCuts(listOf(SourceCut(0.0, 3.0), SourceCut(2.0, 4.0)))
    }
    assertEquals(
      listOf(SourceCut(3.0, 4.0), SourceCut(0.0, 1.0)),
      MediaExportTimeline.validateCuts(listOf(SourceCut(3.0, 4.0), SourceCut(0.0, 1.0))),
    )
  }

  @Test
  fun preservesCaptionOrderAndRejectsAmbiguousOverlap() {
    val mapped = MediaExportTimeline.mapCaptions(
      captions = listOf(
        SourceCaption(2.0, 3.0, "second"),
        SourceCaption(0.0, 1.0, "first"),
      ),
      cuts = emptyList(),
    )
    assertEquals(
      listOf(
        MappedCaption(0L, 1_000_000L, "first"),
        MappedCaption(2_000_000L, 3_000_000L, "second"),
      ),
      mapped,
    )

    assertThrows(IllegalArgumentException::class.java) {
      MediaExportTimeline.validateCaptions(
        listOf(SourceCaption(0.0, 2.0, "one"), SourceCaption(1.0, 3.0, "two")),
      )
    }
  }
}
