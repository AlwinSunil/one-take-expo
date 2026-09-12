package com.onetake.captureinput

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler

/** Adds the activity delegate hook without changing generated React activity sources. */
class OneTakeCaptureInputPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context): List<ReactActivityHandler> =
    listOf(CaptureInputActivityHandler())
}
