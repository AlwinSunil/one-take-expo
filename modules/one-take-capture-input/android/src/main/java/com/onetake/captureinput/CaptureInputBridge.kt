package com.onetake.captureinput

import android.view.KeyEvent
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

internal object CaptureInputBridge {
  private val active = AtomicBoolean(false)
  private val generation = AtomicInteger(0)
  private val nextEventId = AtomicLong(0)
  @Volatile private var listener: ((Map<String, Any?>) -> Unit)? = null

  fun setListener(next: ((Map<String, Any?>) -> Unit)?) {
    listener = next
  }

  fun setActive(value: Boolean) {
    val changed = active.getAndSet(value) != value
    if (value && changed) generation.incrementAndGet()
  }

  fun isActive(): Boolean = active.get()

  fun consume(keyCode: Int, event: KeyEvent?): Boolean {
    if (!active.get()) return false
    val command = commandForKeyCode(keyCode) ?: return false
    if (event == null || event.action == KeyEvent.ACTION_UP) return true
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount > 0) return true

    listener?.invoke(
      mapOf(
        "command" to command,
        "source" to "native-key",
        "eventId" to nextEventId.incrementAndGet(),
        "generation" to generation.get(),
      ),
    )
    return true
  }

  private fun commandForKeyCode(keyCode: Int): String? = when (keyCode) {
    KeyEvent.KEYCODE_VOLUME_UP,
    KeyEvent.KEYCODE_CAMERA,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "advance"
    KeyEvent.KEYCODE_VOLUME_DOWN -> "scratch"
    else -> null
  }
}
