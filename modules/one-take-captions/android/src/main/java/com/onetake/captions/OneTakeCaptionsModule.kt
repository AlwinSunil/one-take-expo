package com.onetake.captions

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Expo bridge for the Android-only Moonshine Tiny Streaming caption engine. */
class OneTakeCaptionsModule : Module() {
  private var controller: CaptionSessionController? = null

  override fun definition() = ModuleDefinition {
    Name("OneTakeCaptions")
    Events("onCaption", "onStatus")

    OnCreate {
      val context = appContext.reactContext?.applicationContext
        ?: throw Exceptions.AppContextLost()
      controller = CaptionSessionController(
        context = context,
        onCaption = { event -> sendEvent("onCaption", event) },
        onStatus = { event -> sendEvent("onStatus", event) },
      )
    }

    AsyncFunction("start") Coroutine { sessionId: String ->
      requireController().start(sessionId)
    }

    AsyncFunction("stop") Coroutine { sessionId: String ->
      requireController().stop(sessionId)
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

  private fun requireController(): CaptionSessionController =
    controller ?: throw Exceptions.AppContextLost()
}
