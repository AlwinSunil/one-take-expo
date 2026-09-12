package com.onetake.captions

import ai.moonshine.voice.JNI
import ai.moonshine.voice.Transcriber
import ai.moonshine.voice.TranscriberOption
import ai.moonshine.voice.TranscriptEvent
import ai.moonshine.voice.TranscriptLine
import java.io.File

/** A single serial Moonshine stream. Methods are called by the inference job. */
internal class MoonshineEngine(directory: File, architecture: Int = JNI.MOONSHINE_MODEL_ARCH_TINY_STREAMING) : AutoCloseable {
  companion object {
    private const val SAMPLE_RATE = LiveMicrophone.SAMPLE_RATE
    private const val TRANSCRIPTION_INTERVAL_SECONDS = "0.2"
    private const val MAX_DISPLAY_LINES = 3
  }

  data class Segment(val id: String, val t0: Double, val t1: Double, val text: String, val isFinal: Boolean) {
    fun event(): Map<String, Any> = mapOf("id" to id, "t0" to t0, "t1" to t1, "text" to text, "isFinal" to isFinal)
  }
  data class Snapshot(val text: String, val isFinal: Boolean, val segments: List<Segment>)

  private data class Line(val text: String, val startTime: Float, val duration: Float, val complete: Boolean)

  private val lock = Any()
  private val transcriber = Transcriber(
    listOf(
      // Match the verified benchmark cadence. Moonshine's default VAD threshold
      // remains in effect, so the streaming path does not add a second gate.
      TranscriberOption("transcription_interval", TRANSCRIPTION_INTERVAL_SECONDS),
    ),
  )
  private val listener = java.util.function.Consumer<TranscriptEvent> { event ->
    event.accept(eventVisitor)
  }
  private val eventVisitor = object : TranscriptEvent.Visitor {
    override fun onLineStarted(event: TranscriptEvent.LineStarted) = update(event.line)
    override fun onLineUpdated(event: TranscriptEvent.LineUpdated) = update(event.line)
    override fun onLineTextChanged(event: TranscriptEvent.LineTextChanged) = update(event.line)
    override fun onLineSpeakersChanged(event: TranscriptEvent.LineSpeakersChanged) = update(event.line)
    override fun onLineCompleted(event: TranscriptEvent.LineCompleted) = update(event.line)
    override fun onError(event: TranscriptEvent.Error) {
      synchronized(lock) {
        if (callbackFailure == null) {
          callbackFailure = event.cause ?: IllegalStateException("Moonshine recognition failed")
        }
      }
    }
  }

  private val lines = linkedMapOf<Long, Line>()
  private var callbackFailure: Throwable? = null
  private var closed = false

  init {
    try {
      transcriber.loadFromFiles(
        directory.absolutePath + File.separator,
        architecture,
      )
      transcriber.setUpdateInterval(0.2)
      transcriber.addListener(listener)
      transcriber.start()
    } catch (failure: Throwable) {
      runCatching { transcriber.removeListener(listener) }
      runCatching { transcriber.close() }
      throw IllegalStateException("Could not start Moonshine Tiny Streaming", failure)
    }
  }

  /** Feeds one 16 kHz mono PCM frame to the native stream. */
  fun addAudio(samples: FloatArray) {
    require(samples.isNotEmpty()) { "Caption audio frame is empty" }
    synchronized(lock) {
      check(!closed) { "Moonshine captions are already closed" }
      callbackFailure?.let { throw recognitionFailure(it) }
    }
    transcriber.addAudio(samples, SAMPLE_RATE)
    synchronized(lock) {
      callbackFailure?.let { throw recognitionFailure(it) }
    }
  }

  /** Stops the native stream after all captured frames have been submitted. */
  fun finish() {
    synchronized(lock) {
      check(!closed) { "Moonshine captions are already closed" }
      callbackFailure?.let { throw recognitionFailure(it) }
    }
    try {
      transcriber.stop()
    } finally {
      synchronized(lock) {
        callbackFailure?.let { throw recognitionFailure(it) }
      }
    }
  }

  /** Returns the latest three non-empty model lines for display. */
  fun transcript(): List<Segment> = synchronized(lock) {
    lines.entries.map { (id, line) ->
      Segment(id.toString(), line.startTime.toDouble().coerceAtLeast(0.0),
        (line.startTime + line.duration).toDouble().coerceAtLeast(line.startTime.toDouble()), line.text, line.complete)
    }.sortedBy { it.t0 }
  }

  fun snapshot(forceFinal: Boolean = false): Snapshot = synchronized(lock) {
    val visibleLines = transcript().takeLast(MAX_DISPLAY_LINES)
    Snapshot(
      text = visibleLines.joinToString(separator = "\n") { it.text },
      isFinal = visibleLines.isNotEmpty() && visibleLines.all { it.isFinal },
      segments = visibleLines,
    )
  }

  override fun close() {
    synchronized(lock) {
      if (closed) return
      closed = true
    }
    runCatching { transcriber.removeListener(listener) }
    runCatching { transcriber.close() }
  }

  private fun update(line: TranscriptLine) {
    val text = line.text.orEmpty().trim()
    synchronized(lock) {
      if (closed) return
      if (text.isEmpty()) {
        lines.remove(line.id)
        return
      }
      if (!line.startTime.isFinite() || !line.duration.isFinite()) return
      lines[line.id] = Line(text, line.startTime, line.duration, line.isComplete)
    }
  }

  private fun recognitionFailure(cause: Throwable): IllegalStateException =
    IllegalStateException("Moonshine recognition failed", cause)
}
