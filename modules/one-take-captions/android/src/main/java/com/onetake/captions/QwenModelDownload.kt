package com.onetake.captions

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

internal object QwenModelDownload {
  const val FILE_NAME = "qwen-sm8850-v0.62.2.zip"
  private const val URL = "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/qwen3_0_6b/releases/v0.62.2/qwen3_0_6b-geniex_qairt-w4a16-qualcomm_snapdragon_8_elite_gen5.zip"
  private const val SHA256 = "6059d8f23a36557d7cd5aa9f1c8f0c5769f9b4272b38532b81851dc4e5f0ef6b"
  private const val SIZE = 643_327_810L
  private val lock = Mutex()
  private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .callTimeout(15, TimeUnit.MINUTES)
    .build()

  suspend fun ensure(context: Context): File = withContext(Dispatchers.IO) {
    lock.withLock {
      val directory = File(context.filesDir, "local-ai")
      check(directory.isDirectory || directory.mkdirs()) { "Could not create local AI storage." }
      val destination = File(directory, FILE_NAME)
      if (valid(destination)) return@withLock destination
      if (destination.exists() && !destination.delete()) throw IOException("Could not replace the incomplete local AI model.")
      val partial = File(directory, "$FILE_NAME.part")
      if (partial.length() >= SIZE) {
        if (valid(partial)) return@withLock publish(partial, destination)
        if (!partial.delete()) throw IOException("Could not restart the local AI download.")
      }
      val offset = partial.length()
      val request = Request.Builder().url(URL).header("Accept-Encoding", "identity")
        .apply { if (offset > 0) header("Range", "bytes=$offset-") }
        .build()
      val call = client.newCall(request)
      try {
        currentCoroutineContext().ensureActive()
        call.execute().use { response ->
          if (response.code != 200 && response.code != 206) throw IOException("Local AI download failed (HTTP ${response.code}). Retry when connected.")
          val append = response.code == 206
          if (append) {
            val range = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(response.header("Content-Range") ?: "")
            if (range == null || range.groupValues[1].toLongOrNull() != offset || range.groupValues[2].toLongOrNull() != SIZE - 1 || range.groupValues[3].toLongOrNull() != SIZE) {
              throw IOException("Local AI download returned an invalid resume range. Retry the download.")
            }
          }
          val body = response.body ?: throw IOException("Local AI download returned no data.")
          val beginning = if (append) offset else 0L
          if (body.contentLength() >= 0 && body.contentLength() != SIZE - beginning) throw IOException("Local AI download size did not match. Retry the download.")
          // A server may ignore Range and return the full archive; truncation prevents appending it twice.
          FileOutputStream(partial, append).use { output ->
            body.byteStream().use { input ->
              val buffer = ByteArray(128 * 1024)
              var received = beginning
              while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                received += count
                if (received > SIZE) throw IOException("Local AI download exceeded its expected size.")
                output.write(buffer, 0, count)
              }
              output.fd.sync()
              if (received != SIZE) throw IOException("Local AI download was interrupted. Retry to resume.")
            }
          }
        }
      } finally {
        call.cancel()
      }
      currentCoroutineContext().ensureActive()
      if (!valid(partial)) {
        if (!partial.delete()) throw IOException("Local AI verification failed. Could not clear its incomplete download.")
        throw IOException("Local AI verification failed. Retry the download.")
      }
      publish(partial, destination)
    }
  }

  private suspend fun valid(file: File): Boolean {
    if (!file.isFile || file.length() != SIZE) return false
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        currentCoroutineContext().ensureActive()
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) } == SHA256
  }

  private fun publish(partial: File, destination: File): File {
    check(partial.renameTo(destination)) { "Could not save the verified local AI model." }
    return destination
  }
}
