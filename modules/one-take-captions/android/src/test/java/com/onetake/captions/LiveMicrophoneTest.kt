package com.onetake.captions

import android.media.AudioRecord
import org.junit.Assert.assertEquals
import org.junit.Test

class LiveMicrophoneTest {
  @Test
  fun `capture uses nonblocking reads so stop does not depend on a blocking wakeup`() {
    assertEquals(AudioRecord.READ_NON_BLOCKING, LiveMicrophone.READ_MODE)
  }
}
