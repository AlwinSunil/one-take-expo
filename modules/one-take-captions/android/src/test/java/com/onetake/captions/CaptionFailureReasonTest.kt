package com.onetake.captions

import org.junit.Assert.*
import org.junit.Test

class CaptionFailureReasonTest {
  @Test fun aMissingAssetAndACorruptOneAreDifferentReasons() {
    assertEquals(
      CaptionFailureReason.MODEL_MISSING,
      CaptionFailureReason.classify(
        "Moonshine model asset 'encoder.ort' is unavailable. " +
          "Run python3 tools/prepare_moonshine.py before building.",
      ),
    )
    assertEquals(
      CaptionFailureReason.MODEL_CORRUPT,
      CaptionFailureReason.classify("Caption model checksum mismatch: decoder_kv.ort"),
    )
  }

  @Test fun permissionAndDeviceSupportAreNotInitializationFailures() {
    assertEquals(
      CaptionFailureReason.PERMISSION_DENIED,
      CaptionFailureReason.classify("Microphone permission is unavailable"),
    )
    assertEquals(
      CaptionFailureReason.UNSUPPORTED_DEVICE,
      CaptionFailureReason.classify("Moonshine live captions require an arm64-v8a device"),
    )
  }

  @Test fun anUnrecognizedFailureIsNotGivenAnInventedCause() {
    assertEquals(
      CaptionFailureReason.INITIALIZATION_FAILED,
      CaptionFailureReason.classify("Could not start caption inference"),
    )
    assertEquals(CaptionFailureReason.UNKNOWN, CaptionFailureReason.classify(null))
    assertEquals(CaptionFailureReason.UNKNOWN, CaptionFailureReason.classify("   "))
  }
}
