package com.onetake.captions

import org.junit.Assert.assertEquals
import org.junit.Test

class AcousticFillerSegmentationTest {
  @Test fun mergesAdjacentSameLabelFramesAndKeepsTheWeakestScore() {
    val frames = listOf(
      AcousticFillerFrame(0, AcousticFillerLabel.UM, 0.91),
      AcousticFillerFrame(320, AcousticFillerLabel.UM, 0.67),
      AcousticFillerFrame(640, null, 0.0),
    )

    assertEquals(
      listOf(AcousticFillerEvent(0, 640, AcousticFillerLabel.UM, 0.67)),
      AcousticFillerSegmentation.segment(frames, durationSamples = 960),
    )
  }

  @Test fun splitsDifferentLabelsAndDoesNotBridgeUnclassifiedFrames() {
    val frames = listOf(
      AcousticFillerFrame(0, AcousticFillerLabel.UM, 0.8),
      AcousticFillerFrame(320, AcousticFillerLabel.UH, 0.75),
      AcousticFillerFrame(640, null, 0.0),
      AcousticFillerFrame(960, AcousticFillerLabel.UH, 0.72),
    )

    assertEquals(
      listOf(
        AcousticFillerEvent(0, 320, AcousticFillerLabel.UM, 0.8),
        AcousticFillerEvent(320, 640, AcousticFillerLabel.UH, 0.75),
        AcousticFillerEvent(960, 1_280, AcousticFillerLabel.UH, 0.72),
      ),
      AcousticFillerSegmentation.segment(frames, durationSamples = 1_280),
    )
  }

  @Test fun clampsTheLastFrameToTheDecodedSourceDuration() {
    val frames = listOf(AcousticFillerFrame(320, AcousticFillerLabel.UM, 0.6))

    assertEquals(
      listOf(AcousticFillerEvent(320, 500, AcousticFillerLabel.UM, 0.6)),
      AcousticFillerSegmentation.segment(frames, durationSamples = 500),
    )
  }
}
