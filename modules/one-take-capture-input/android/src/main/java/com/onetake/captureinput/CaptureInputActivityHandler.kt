package com.onetake.captureinput

import android.view.KeyEvent
import expo.modules.core.interfaces.ReactActivityHandler

/** Routes supported hardware keys through the Expo activity delegate while a take is active. */
internal class CaptureInputActivityHandler : ReactActivityHandler {
  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean =
    CaptureInputBridge.consume(keyCode, event)

  override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean =
    CaptureInputBridge.consume(keyCode, event)

  override fun onKeyLongPress(keyCode: Int, event: KeyEvent?): Boolean =
    CaptureInputBridge.consume(keyCode, event)
}
