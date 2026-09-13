package com.onetake.vision

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class FaceExposureTest {
  private val face = VisionFaceBounds(0.2f, 0.2f, 0.8f, 0.8f, null)
  @Test fun limitedRangeWhiteCountsAsBright() {
    val buffer = ByteBuffer.wrap(ByteArray(160*160) { 235.toByte() })
    assertEquals(1.0, FaceExposure.sample(buffer, 160, 160, 160, 1, 0, face)["clipped"]!!, 0.001)
  }
  @Test fun missingOrUndersampledFaceHasNoLightingEvidence() {
    val buffer = ByteBuffer.wrap(ByteArray(160*160))
    assertTrue(FaceExposure.sample(buffer, 160, 160, 160, 1, 0, null).isEmpty())
    assertTrue(FaceExposure.sample(buffer, 160, 160, 160, 1, 0, VisionFaceBounds(0.49f, 0.49f, 0.51f, 0.51f, null)).isEmpty())
  }
  @Test fun samplingHonorsBufferOffsetAndStride() {
    val bytes = ByteArray(17+320*160)
    for (y in 0 until 160) for (x in 0 until 160) bytes[17+y*320+x*2] = 128.toByte()
    val buffer = ByteBuffer.wrap(bytes).apply { position(17) }
    val result = FaceExposure.sample(buffer, 160, 160, 320, 2, 90, face)
    assertEquals(128.0/255, result["mean"]!!, 0.001)
    assertEquals(0.0, result["dark"]!!, 0.001)
    assertEquals(17, buffer.position())
  }
  @Test fun brightBackgroundOutsideFaceDoesNotWarn() {
    val bytes = ByteArray(160*160) { 235.toByte() }
    for (y in 32 until 128) for (x in 32 until 128) bytes[y*160+x] = 128.toByte()
    assertEquals(0.0, FaceExposure.sample(ByteBuffer.wrap(bytes), 160, 160, 160, 1, 0, face)["clipped"]!!, 0.001)
  }
  @Test fun rotationSamplesTheDetectedFaceInSensorCoordinates() {
    val bytes = ByteArray(320*320) { 128.toByte() }
    for (y in 32 until 128) for (x in 32 until 128) bytes[y*320+x] = 235.toByte()
    val uprightFace = VisionFaceBounds(0.6f, 0.1f, 0.9f, 0.4f, null)
    assertEquals(1.0, FaceExposure.sample(ByteBuffer.wrap(bytes), 320, 320, 320, 1, 90, uprightFace)["clipped"]!!, 0.001)
    assertEquals(0.0, FaceExposure.sample(ByteBuffer.wrap(bytes), 320, 320, 320, 1, 0, uprightFace)["clipped"]!!, 0.001)
  }

}
