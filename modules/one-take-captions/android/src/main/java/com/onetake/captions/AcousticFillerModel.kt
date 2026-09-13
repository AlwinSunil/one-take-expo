package com.onetake.captions

import android.content.Context
import android.os.Build
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class AcousticFillerCapability(
  val available: Boolean,
  val reason: String? = null,
)

internal class AcousticFillerUnavailable(message: String) : IllegalStateException(message)

/** Installs and verifies the debug-only pinned Uhm model without network I/O. */
internal object AcousticFillerModel {
  const val MODEL_ID = "desert-ant-labs/uhm-web-fp16"
  const val MODEL_VERSION = "612592c10ad7b2a51f3237725448a1aad212480b"
  const val MODEL_SHA256 = "c266faf7db4cdced6f18aa9119ff2800a20707d7159be645d487ec191a9d79ff"
  const val MODEL_SIZE_BYTES = 47_047_128L
  const val MODEL_ASSET = "uhm-web-fp16.onnx"
  const val SAMPLE_RATE = 16_000
  const val THRESHOLD = 0.5f

  private const val MODEL_DIRECTORY = "acoustic-fillers"
  private const val MODEL_FILE = "uhm-web-fp16.onnx"
  private val lock = Mutex()
  private var prepared: File? = null

  fun baseUnavailableReason(context: Context): String? {
    val app = context.applicationInfo
    if (app.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0) {
      return "Acoustic filler detection is available only in a debuggable build"
    }
    if (Build.VERSION.SDK_INT < 26) {
      return "Acoustic filler detection requires Android API 26 or newer"
    }
    if (!Build.SUPPORTED_ABIS.any { it == "arm64-v8a" }) {
      return "Acoustic filler detection requires an arm64-v8a device"
    }
    return null
  }

  suspend fun capability(context: Context): AcousticFillerCapability = withContext(Dispatchers.IO) {
    baseUnavailableReason(context)?.let { return@withContext AcousticFillerCapability(false, it) }
    val assetReason = verifyAsset(context)
    if (assetReason != null) {
      return@withContext AcousticFillerCapability(false, assetReason)
    }
    val bridgeError = AcousticFillerNative.ensureLoaded()
    if (bridgeError != null) {
      return@withContext AcousticFillerCapability(false, bridgeError)
    }
    val runtimeError = runCatching { AcousticFillerNative.runtimeVersion() }.exceptionOrNull()
    if (runtimeError != null) {
      return@withContext AcousticFillerCapability(
        false,
        runtimeError.message ?: "The shared Moonshine ONNX Runtime is unavailable",
      )
    }
    AcousticFillerCapability(true)
  }

  suspend fun prepare(context: Context): File = withContext(Dispatchers.IO) {
    baseUnavailableReason(context)?.let { throw AcousticFillerUnavailable(it) }
    lock.withLock {
      prepared?.takeIf { it.isFile && it.length() == MODEL_SIZE_BYTES && sha256(it) == MODEL_SHA256 }?.let {
        return@withLock it
      }

      val directory = File(context.noBackupFilesDir, MODEL_DIRECTORY)
      check(directory.isDirectory || directory.mkdirs()) {
        "Could not create the acoustic filler model directory"
      }
      val destination = File(directory, MODEL_FILE)
      val temporary = File(directory, "$MODEL_FILE.part")
      try {
        context.assets.open(MODEL_ASSET).use { input ->
          FileOutputStream(temporary).use { output ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
              currentCoroutineContext().ensureActive()
              val count = input.read(buffer)
              if (count < 0) break
              total += count
              if (total > MODEL_SIZE_BYTES) {
                throw AcousticFillerUnavailable("The Uhm model asset is larger than the pinned artifact")
              }
              digest.update(buffer, 0, count)
              output.write(buffer, 0, count)
            }
            output.flush()
            output.fd.sync()
            check(total == MODEL_SIZE_BYTES && hex(digest.digest()) == MODEL_SHA256) {
              "The Uhm model asset checksum differs from the pinned artifact"
            }
          }
        }
        check(temporary.renameTo(destination)) {
          "Could not install the verified Uhm model"
        }
        prepared = destination
        destination
      } catch (cancelled: kotlinx.coroutines.CancellationException) {
        throw cancelled
      } catch (failure: AcousticFillerUnavailable) {
        throw failure
      } catch (failure: Throwable) {
        throw AcousticFillerUnavailable(
          "The Uhm model asset is unavailable. Build a debuggable APK with the staged model.",
        )
      } finally {
        temporary.delete()
      }
    }
  }

  suspend fun hashFile(file: File): String = withContext(Dispatchers.IO) {
    sha256(file)
  }

  private fun verifyAsset(context: Context): String? {
    return try {
      context.assets.open(MODEL_ASSET).use { input ->
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          if (total > MODEL_SIZE_BYTES) return "The Uhm model asset is larger than the pinned artifact"
          digest.update(buffer, 0, count)
        }
        if (total != MODEL_SIZE_BYTES || hex(digest.digest()) != MODEL_SHA256) {
          "The Uhm model asset checksum differs from the pinned artifact"
        } else {
          null
        }
      }
    } catch (_: Throwable) {
      "The Uhm model asset is missing from this debuggable build"
    }
  }

  private fun sha256(file: File): String {
    require(file.isFile && file.canRead()) { "Cannot read file for SHA-256" }
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(bytes: ByteArray): String = bytes.joinToString(separator = "") { byte ->
    "%02x".format(byte.toInt() and 0xff)
  }
}
