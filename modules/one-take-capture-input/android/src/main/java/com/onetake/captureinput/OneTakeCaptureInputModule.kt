package com.onetake.captureinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Expo bridge for active-capture hardware input. */
class OneTakeCaptureInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OneTakeCaptureInput")
    Events("onInput")

    Function("setCaptureActive") { active: Boolean ->
      CaptureInputBridge.setActive(active)
    }

    OnCreate {
      CaptureInputBridge.setListener { event -> sendEvent("onInput", event) }
    }

    OnDestroy {
      CaptureInputBridge.setListener(null)
      CaptureInputBridge.setActive(false)
    }
  }
}
