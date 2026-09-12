package com.onetake.vision

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo bridge for optional Android face presence analysis. CameraView remains
 * the recorder owner; this module only contributes a shared ImageAnalysis lane.
 */
class OneTakeVisionModule : Module() {
  private var controller: VisionSessionController? = null

  override fun definition() = ModuleDefinition {
    Name("OneTakeVision")
    Events("onVisionStatus", "onVisionFrame")

    OnCreate {
      val context = appContext.reactContext?.applicationContext
        ?: throw Exceptions.AppContextLost()
      controller = VisionSessionController(
        context = context,
        activityProvider = { appContext.currentActivity },
        onStatus = { event -> sendEvent("onVisionStatus", event) },
        onFrame = { event -> sendEvent("onVisionFrame", event) },
      )
    }

    AsyncFunction("start") Coroutine { sessionId: String, lensFacing: String ->
      require(lensFacing == "front" || lensFacing == "back") { "Unsupported lens facing" }
      requireController().start(sessionId, lensFacing)
    }

    AsyncFunction("stop") Coroutine { sessionId: String ->
      requireController().stop(sessionId)
    }

    AsyncFunction("getDeviceStatus") {
      requireController().deviceStatus()
    }

    AsyncFunction("getDiagnostics") {
      requireController().diagnostics()
    }

    OnActivityEntersBackground {
      controller?.requestStopFromLifecycle("activity_background")
    }

    OnActivityDestroys {
      controller?.requestStopFromLifecycle("activity_destroyed")
    }

    OnDestroy {
      controller?.close()
      controller = null
    }
  }

  private fun requireController(): VisionSessionController =
    controller ?: throw Exceptions.AppContextLost()
}

