package com.onetake.captions

import android.content.Context
import android.os.Build
import com.geniex.sdk.GenieXSdk
import com.geniex.sdk.LlmWrapper
import com.geniex.sdk.ModelManagerWrapper
import com.geniex.sdk.bean.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal class LocalScriptModel(private val context: () -> Context) {
  private val lock = Mutex()
  private var model: LlmWrapper? = null
  @Volatile private var state = "downloadable"
  private val modelName = "local/onetake-qwen3-sm8850"

  fun status(): String = if (supported()) state else "unavailable"

  private fun supported() = Build.VERSION.SDK_INT >= 31 &&
    Build.SUPPORTED_ABIS.contains("arm64-v8a") && Build.SOC_MODEL == "SM8850"

  suspend fun prepare(): String = withContext(Dispatchers.IO) {
    lock.withLock {
      if (!supported()) return@withLock "unavailable"
      if (model != null) return@withLock "available"
      try {
        var initError: String? = null
        GenieXSdk.getInstance().init(context(), object : GenieXSdk.InitCallback {
          override fun onSuccess() {}
          override fun onFailure(reason: String) { initError = reason }
        })
        check(initError == null) { initError!! }
        if (ModelManagerWrapper.getPaths(modelName) == null) {
          state = "downloading"
          val archive = QwenModelDownload.ensure(context())
          withTimeout(900_000L) {
            ModelManagerWrapper.pullFlow(ModelPullInput(
              model_name = modelName, hub = HubSource.LOCALFS, local_path = archive.absolutePath,
            )).buffer(Channel.UNLIMITED).collect { event ->
              if (event is ModelManagerWrapper.PullEvent.Error) error(event.message)
            }
          }
        }
        val paths = ModelManagerWrapper.getPaths(modelName) ?: error("Model download did not finish.")
        model = LlmWrapper.builder().llmCreateInput(LlmCreateInput(
          model_path = paths.model_path,
          tokenizer_path = paths.tokenizer_path,
          config = ModelConfig(nCtx = 0, nGpuLayers = 0),
          runtime_id = "qairt", compute_unit = "npu",
        )).build().getOrThrow()
        state = "available"
        state
      } catch (error: Exception) {
        state = "downloadable"
        throw error
      }
    }
  }

  suspend fun prompt(text: String): String = withContext(Dispatchers.IO) {
    lock.withLock {
      require(text.length <= 10_000) { "Split this script into shorter sections." }
      val engine = model ?: error("Local AI is not ready yet.")
      check(engine.reset() == 0) { "Local AI could not reset its previous context." }
      val template = engine.applyChatTemplate(arrayOf(ChatMessage("user", text)), null, false).getOrThrow()
      val result = StringBuilder()
      coroutineScope {
        var timedOut = false
        val watchdog = launch { delay(20_000L); timedOut = true; engine.stopStream() }
        try {
        engine.generateStreamFlow(template.formattedText, GenerationConfig(
          maxTokens = 256, samplerConfig = SamplerConfig(temperature = 0f),
        )).buffer(Channel.UNLIMITED).collect { event ->
          when (event) {
            is LlmStreamResult.Token -> result.append(event.text)
            is LlmStreamResult.Error -> throw event.throwable
            is LlmStreamResult.Completed -> Unit
          }
        }
        check(!timedOut) { "Local AI took too long. Please retry." }
        } finally { watchdog.cancel() }
      }
      result.toString().ifBlank { error("Local AI returned no result.") }
    }
  }
}
