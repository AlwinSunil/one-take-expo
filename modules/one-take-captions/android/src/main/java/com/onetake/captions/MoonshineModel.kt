package com.onetake.captions

import android.content.Context
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Installs the pinned Tiny Streaming English weights into the app's private
 * files directory. The model is bundled in the APK, so preparation never
 * performs network I/O or depends on an external model cache.
 */
internal object MoonshineModel {
  private const val MODEL_DIRECTORY = "moonshine-tiny-26-08-21"
  private const val ASSET_DIRECTORY = "moonshine-tiny"

  private val lock = Mutex()
  private val hashes = linkedMapOf(
    "streaming_config.json" to "74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950",
    "encoder.ort" to "a8414e1a5dedf9f2093d7680601dd8a9b0433e7020260eafe0e370ead91134ca",
    "decoder_kv.ort" to "8852553f312adb6c9aa4d17418015049b30f412209ee569d336548c0044627de",
    "adapter.ort" to "22ecc949e146c49667fda28d102d4e30749a107dc88a396292aa8f277ef1347c",
    "frontend.weights.ort" to "217da24ac6f522ebf02da8ef288e77d1ac68d50d4a6821433182e4fbf4204bbd",
    "cross_kv.ort" to "143a36667b8d05fd9d04e8c337b7ee121f37ef299aea6b3d82bdb3d3401950b4",
    "tokenizer.bin" to "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d",
    "frontend.model.ort" to "5121b561417b638afce0c6c31b760e37c93cf97f80d9b0031aad1fe7b6f25d61",
  )
  private val prepared = mutableMapOf<Boolean, File>()

  suspend fun directory(context: Context, small: Boolean = false): File = withContext(Dispatchers.IO) {
    lock.withLock {
      val selectedHashes = if (small) SmallMoonshineHashes.values else hashes
      prepared[small]?.takeIf { directory -> hasAllFiles(directory, selectedHashes) }?.let { return@withLock it }

      val directory = File(context.noBackupFilesDir, if (small) "moonshine-small-26-08-21" else MODEL_DIRECTORY)
      check(directory.isDirectory || directory.mkdirs()) {
        "Could not create the offline Moonshine model directory"
      }

      for ((name, expectedHash) in selectedHashes) {
        currentCoroutineContext().ensureActive()
        val destination = File(directory, name)
        if (destination.isFile && digest(destination) == expectedHash) {
          continue
        }

        val temporary = File(directory, "$name.part")
        try {
          context.assets.open("${if (small) "moonshine-small" else ASSET_DIRECTORY}/$name").use { input ->
            temporary.outputStream().use { output -> input.copyTo(output) }
          }
          check(digest(temporary) == expectedHash) {
            "Caption model checksum mismatch: $name"
          }
          check(temporary.renameTo(destination)) {
            "Could not install caption model: $name"
          }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
          throw cancelled
        } catch (failure: Throwable) {
          throw IllegalStateException(
            "Moonshine model asset '$name' is unavailable. " +
              "Run python3 tools/prepare_moonshine.py before building.",
            failure,
          )
        } finally {
          temporary.delete()
        }
      }

      prepared[small] = directory
      directory
    }
  }

  private fun hasAllFiles(directory: File, selectedHashes: Map<String, String>): Boolean =
    directory.isDirectory && selectedHashes.all { (name, expectedHash) ->
      val file = File(directory, name)
      file.isFile && digest(file) == expectedHash
    }

  private fun digest(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        hash.update(buffer, 0, count)
      }
    }
    return hash.digest().joinToString(separator = "") { byte ->
      "%02x".format(byte.toInt() and 0xff)
    }
  }
}
