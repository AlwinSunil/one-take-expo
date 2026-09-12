package com.onetake.captions

import android.media.AudioFormat
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class PcmDecoderTest {
  @Test fun decodesLittleEndianRegardlessOfBufferViewLimit() {
    val source = ByteBuffer.wrap(byteArrayOf(99, 99, 0, -128, -1, 127, 99))
    source.limit(1)
    val samples = PcmDecoder.decode(source, 2, 4, AudioFormat.ENCODING_PCM_16BIT, 1)
    assertArrayEquals(floatArrayOf(-1f, 32767f / 32768f), samples, 0.00001f)
  }
  @Test fun excludesIncompleteStereoFrames() {
    val samples = PcmDecoder.decode(ByteBuffer.wrap(ByteArray(7)), 0, 7, AudioFormat.ENCODING_PCM_16BIT, 2)
    assertEquals(2, samples.size)
  }
}
