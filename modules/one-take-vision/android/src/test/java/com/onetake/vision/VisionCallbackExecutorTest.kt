package com.onetake.vision

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VisionCallbackExecutorTest {
  @Test fun runsLateCleanupWhenCallbackExecutorIsAlreadyTerminated() {
    val closed = AtomicBoolean(true)
    val invoked = AtomicInteger(0)
    val rejectedDelegate = Executor { throw RejectedExecutionException("terminated") }

    VisionCallbackExecutor(rejectedDelegate, closed::get).execute {
      invoked.incrementAndGet()
    }

    assertEquals(1, invoked.get())
  }

  @Test fun suppressesLateCallbackFailureAfterAnalyzerClose() {
    val closed = AtomicBoolean(true)
    val rejectedDelegate = Executor { throw RejectedExecutionException("terminated") }

    VisionCallbackExecutor(rejectedDelegate, closed::get).execute {
      error("late listener body")
    }
  }

  @Test fun forwardsCallbacksWhileOpen() {
    val closed = AtomicBoolean(false)
    val invoked = AtomicInteger(0)
    val direct = Executor { it.run() }

    VisionCallbackExecutor(direct, closed::get).execute {
      invoked.incrementAndGet()
    }

    assertEquals(1, invoked.get())
  }

  @Test fun preservesUnexpectedRejectionWhileOpen() {
    val closed = AtomicBoolean(false)
    val rejectedDelegate = Executor { throw RejectedExecutionException("unexpected") }

    assertThrows(RejectedExecutionException::class.java) {
      VisionCallbackExecutor(rejectedDelegate, closed::get).execute(Runnable {})
    }
  }
}
