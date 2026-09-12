package com.onetake.captions

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.net.Uri
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Expo bridge for the Android-only Moonshine Tiny Streaming caption engine. */
class OneTakeCaptionsModule : Module() {
  private var controller: CaptionSessionController? = null
  private val refinementLock = Mutex()
  private val refinements = ConcurrentHashMap<String, Job>()

  override fun definition() = ModuleDefinition {
    Name("OneTakeCaptions")
    Events("onCaption", "onStatus", "onRefinement")

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
      refinements.values.toList().forEach { it.cancel(); it.join() }
      refinementLock.withLock { requireController().start(sessionId) }
    }

    AsyncFunction("stop") Coroutine { sessionId: String ->
      requireController().stop(sessionId)
    }

    AsyncFunction("refine") Coroutine { id: String, sourceUri: String, model: String ->
      require(id.isNotBlank()) { "Refinement ID is required" }
      require(model == "tiny" || model == "small") { "Unsupported refinement model" }
      require(android.os.Build.VERSION.SDK_INT >= 26 && android.os.Build.SUPPORTED_ABIS.contains("arm64-v8a")) { "Offline captions require arm64 Android 8 or newer" }
      val job = currentCoroutineContext()[Job] ?: error("Refinement job unavailable")
      check(refinements.putIfAbsent(id, job) == null) { "Refinement is already running" }
      try {
        withContext(Dispatchers.Default) {
        refinementLock.withLock {
          check(!requireController().isActive()) { "Finish recording before refining captions" }
          val context = appContext.reactContext?.applicationContext ?: throw Exceptions.AppContextLost()
          val uri = Uri.parse(sourceUri)
          require(uri.scheme == "file") { "Refinement requires an app-owned recording" }
          val file = File(uri.path ?: error("Recording path missing")).canonicalFile
          val owned = listOf(context.filesDir.parentFile!!, context.cacheDir).any { file.path.startsWith(it.canonicalPath + File.separator) }
          require(owned) { "Recording must be inside app-private storage" }
          sendEvent("onRefinement", mapOf("id" to id, "progress" to 0.0, "status" to "decoding"))
          val audio = AudioDecoder.decodeMono16k(file)
          sendEvent("onRefinement", mapOf("id" to id, "progress" to 0.0, "status" to "transcribing", "quietIntervals" to QuietIntervals.find(audio)))
          val architecture = if (model == "small") ai.moonshine.voice.JNI.MOONSHINE_MODEL_ARCH_SMALL_STREAMING else ai.moonshine.voice.JNI.MOONSHINE_MODEL_ARCH_TINY_STREAMING
          MoonshineEngine(MoonshineModel.directory(context, small = model == "small"), architecture).use { engine ->
            var offset = 0
            var lastPercent = -1
            while (offset < audio.size) {
              currentCoroutineContext().ensureActive()
              val end = (offset + 320).coerceAtMost(audio.size)
              engine.addAudio(audio.copyOfRange(offset, end))
              offset = end
              val percent = (offset.toLong() * 100 / audio.size).toInt()
              if (percent != lastPercent) {
                lastPercent = percent
                sendEvent("onRefinement", mapOf("id" to id, "progress" to percent / 100.0, "status" to "transcribing"))
              }
            }
            engine.finish()
            engine.transcript().map { it.event() }
          }
        }
        }
      } finally {
        refinements.remove(id, job)
      }
    }

    AsyncFunction("cancelRefinement") { id: String -> refinements[id]?.cancel(); Unit }

    OnActivityEntersBackground {
      controller?.requestStopFromLifecycle("activity_background")
    }

    OnActivityDestroys {
      controller?.requestStopFromLifecycle("activity_destroyed")
    }

    OnDestroy {
      refinements.values.forEach { it.cancel() }
      controller?.close()
      controller = null
    }
  }

  private fun requireController(): CaptionSessionController =
    controller ?: throw Exceptions.AppContextLost()
}
