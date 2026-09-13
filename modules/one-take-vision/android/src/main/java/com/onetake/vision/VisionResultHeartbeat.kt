package com.onetake.vision

import java.util.concurrent.atomic.AtomicLong

internal class VisionResultHeartbeat(private val clock: () -> Long, private val timeoutMs: Long = 1_000L) {
  private val lastDelivery = AtomicLong(Long.MIN_VALUE)
  fun received() { lastDelivery.set(clock()) }
  fun stale(): Boolean {
    val deliveredAt = lastDelivery.get()
    return deliveredAt != Long.MIN_VALUE && clock() - deliveredAt >= timeoutMs
  }
}
