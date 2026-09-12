package com.onetake.captions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlin.math.min

/**
 * Captures a second microphone stream while expo-camera owns the camera.
 *
 * Audio is delivered as mono 16 kHz PCM. The channel is intentionally bounded:
 * if inference falls more than eight seconds behind capture, the module stops
 * the recorder and reports an overflow instead of silently dropping audio.
 */
internal class LiveMicrophone(private val context: Context) : AutoCloseable {
  companion object {
    const val SAMPLE_RATE = 16_000
    const val FRAME_SAMPLES = 320 // 20 ms, matching the benchmark input pacing.
    const val READ_MODE = AudioRecord.READ_NON_BLOCKING
    private const val QUEUE_CAPACITY_FRAMES = 400 // Eight seconds of PCM.
    private const val EMPTY_READ_LIMIT = 100
    private const val EMPTY_READ_DELAY_MS = 10L
  }

  private val lock = Any()
  private val captureScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private var audioRecord: AudioRecord? = null
  private var output: Channel<FloatArray>? = null
  private var readJob: Job? = null
  private var stopRequested = false
  private var runningState = false
  private var failureState: String? = null
  @Volatile var capturedSamples = 0L
    private set

  /** Creates and starts AudioRecord synchronously for camera/capture handoff. */
  fun start(): Boolean = synchronized(lock) {
    if (runningState || readJob?.isActive == true) {
      failureState = "Microphone is already running"
      return@synchronized false
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
      context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
    ) {
      failureState = "Microphone permission is unavailable"
      return@synchronized false
    }

    failureState = null
    stopRequested = false
    output = Channel(QUEUE_CAPACITY_FRAMES)

    val minimumBufferBytes = try {
      AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    } catch (failure: Throwable) {
      failureState = "Could not query microphone buffer: ${failure.message ?: failure::class.java.simpleName}"
      output?.close()
      output = null
      return@synchronized false
    }
    if (minimumBufferBytes <= 0) {
      failureState = "AudioRecord reported an invalid buffer size"
      output?.close()
      output = null
      return@synchronized false
    }

    val bufferBytes = maxOf(minimumBufferBytes, FRAME_SAMPLES * 4)
      .let { size -> size + (size and 1) }
    val record = try {
      AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
        .setAudioFormat(
          AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build(),
        )
        .setBufferSizeInBytes(bufferBytes)
        .build()
    } catch (_: SecurityException) {
      failureState = "Microphone permission is unavailable"
      output?.close()
      output = null
      return@synchronized false
    } catch (failure: Throwable) {
      failureState = "Could not initialize microphone: ${failure.message ?: failure::class.java.simpleName}"
      output?.close()
      output = null
      return@synchronized false
    }

    if (record.state != AudioRecord.STATE_INITIALIZED) {
      releaseQuietly(record)
      failureState = "AudioRecord could not be initialized"
      output?.close()
      output = null
      return@synchronized false
    }

    try {
      record.startRecording()
    } catch (failure: Throwable) {
      releaseQuietly(record)
      failureState = "Could not start microphone: ${failure.message ?: failure::class.java.simpleName}"
      output?.close()
      output = null
      return@synchronized false
    }
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      stopQuietly(record)
      releaseQuietly(record)
      failureState = "AudioRecord did not enter the recording state"
      output?.close()
      output = null
      return@synchronized false
    }

    audioRecord = record
    runningState = true
    val channel = output ?: error("Audio channel was not created")
    readJob = captureScope.launch {
      readLoop(record, channel)
    }
    true
  }

  /** Requests stop and unblocks a potentially blocking AudioRecord.read call. */
  fun requestStop() {
    val record = synchronized(lock) {
      stopRequested = true
      runningState = false
      audioRecord
    }
    if (record != null) {
      stopQuietly(record)
    }
  }

  /** Returns the current bounded stream. It is closed after the read loop exits. */
  fun chunks(): ReceiveChannel<FloatArray> = synchronized(lock) {
    output ?: error("Microphone has not been started")
  }

  suspend fun awaitStopped() {
    val job = synchronized(lock) { readJob }
    job?.join()
  }

  val running: Boolean
    get() = synchronized(lock) { runningState }

  val failure: String?
    get() = synchronized(lock) { failureState }

  override fun close() {
    requestStop()
    captureScope.cancel()
  }

  private suspend fun readLoop(record: AudioRecord, channel: Channel<FloatArray>) {
    val readBuffer = ShortArray(FRAME_SAMPLES)
    val pending = FloatArray(FRAME_SAMPLES)
    var pendingCount = 0
    var emptyReads = 0
    var lastRoute: Int? = null
    var routeCheck = 0
    try {
      while (!isStopRequested(record)) {
        // Polling keeps stop bounded by the small idle delay even if a vendor
        // AudioRecord implementation does not wake a blocking read reliably.
        val read = record.read(readBuffer, 0, readBuffer.size, READ_MODE)
        if (read < 0) {
          if (!isStopRequested(record)) {
            setFailure("AudioRecord read failed: $read")
          }
          break
        }
        if (read == 0) {
          if (++emptyReads >= EMPTY_READ_LIMIT) {
            setFailure("AudioRecord stopped producing samples")
            break
          }
          delay(EMPTY_READ_DELAY_MS)
          continue
        }
        emptyReads = 0
        capturedSamples += read
        if (++routeCheck % 50 == 0) {
          val route = record.routedDevice
          if (route != null) {
            if (lastRoute != null && lastRoute != route.id) {
              setFailure("Microphone route changed. Finish this take and start another for captions.")
              break
            }
            if (lastRoute == null) android.util.Log.i("MoonshineCaptions", "audio_route type=${route.type} id=${route.id} sample_rate=$SAMPLE_RATE processor=CPU")
            lastRoute = route.id
          }
        }

        var sourceIndex = 0
        while (sourceIndex < read) {
          val copied = min(read - sourceIndex, FRAME_SAMPLES - pendingCount)
          for (index in 0 until copied) {
            pending[pendingCount + index] = readBuffer[sourceIndex + index] / Short.MAX_VALUE.toFloat()
          }
          pendingCount += copied
          sourceIndex += copied
          if (pendingCount == FRAME_SAMPLES) {
            if (!enqueue(channel, pending.copyOf())) {
              return
            }
            pendingCount = 0
          }
        }
      }

      // Keep the final partial frame so stop() drains every sample captured
      // before the AudioRecord was stopped.
      if (pendingCount > 0 && failure == null) {
        enqueue(channel, pending.copyOf(pendingCount))
      }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (failure: Throwable) {
      if (!isStopRequested(record)) {
        setFailure("AudioRecord capture failed: ${failure.message ?: failure::class.java.simpleName}")
      }
    } finally {
      stopQuietly(record)
      releaseQuietly(record)
      channel.close()
      synchronized(lock) {
        if (audioRecord === record) {
          audioRecord = null
          runningState = false
          stopRequested = false
        }
      }
    }
  }

  private fun enqueue(channel: Channel<FloatArray>, frame: FloatArray): Boolean {
    if (channel.trySend(frame).isSuccess) {
      return true
    }
    setFailure("Caption audio buffer overflowed; live captions stopped")
    requestStop()
    return false
  }

  private fun isStopRequested(record: AudioRecord): Boolean = synchronized(lock) {
    stopRequested || audioRecord !== record
  }

  private fun setFailure(message: String) {
    synchronized(lock) {
      if (failureState == null) {
        failureState = message
      }
      stopRequested = true
      runningState = false
    }
  }

  private fun stopQuietly(record: AudioRecord) {
    runCatching { record.stop() }
  }

  private fun releaseQuietly(record: AudioRecord) {
    runCatching { record.release() }
  }
}
