package com.onetake.media

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.exoplayer.FormatHolder
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.source.ClippingMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.SampleStream
import androidx.media3.exoplayer.source.WrappingMediaSource
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy

/** Keeps compressed references after the cut available without adding presentation time. */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class DecodeAheadMediaSourceFactory(context: Context) : MediaSource.Factory {
  private val delegate = DefaultMediaSourceFactory(context)
  override fun getSupportedTypes(): IntArray = delegate.supportedTypes
  override fun setDrmSessionManagerProvider(value: DrmSessionManagerProvider): MediaSource.Factory = apply { delegate.setDrmSessionManagerProvider(value) }
  override fun setLoadErrorHandlingPolicy(value: LoadErrorHandlingPolicy): MediaSource.Factory = apply { delegate.setLoadErrorHandlingPolicy(value) }
  override fun createMediaSource(item: MediaItem): MediaSource {
    val clip = item.clippingConfiguration
    if (clip.endPositionUs == C.TIME_END_OF_SOURCE) return delegate.createMediaSource(item)
    val raw = delegate.createMediaSource(item.buildUpon().setClippingConfiguration(MediaItem.ClippingConfiguration.UNSET).build())
    val ahead = DecodeAheadMediaSource(raw, clip.startPositionUs, clip.endPositionUs)
    return ClippingMediaSource.Builder(ahead)
      .setStartPositionUs(clip.startPositionUs).setEndPositionUs(clip.endPositionUs)
      .setEnableInitialDiscontinuity(!clip.startsAtKeyFrame).build()
  }
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
private class DecodeAheadMediaSource(source: MediaSource, private val startUs: Long, private val endUs: Long) : WrappingMediaSource(source) {
  override fun createPeriod(id: MediaSource.MediaPeriodId, allocator: Allocator, startPositionUs: Long): MediaPeriod =
    DecodeAheadPeriod(mediaSource.createPeriod(id, allocator, startPositionUs), startUs, endUs)
  override fun releasePeriod(mediaPeriod: MediaPeriod) { mediaSource.releasePeriod((mediaPeriod as DecodeAheadPeriod).child) }
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
private class DecodeAheadPeriod(val child: MediaPeriod, private val startUs: Long, private val endUs: Long) : MediaPeriod by child {
  private val streams = mutableListOf<DecodeAheadStream>()
  override fun prepare(callback: MediaPeriod.Callback, positionUs: Long) {
    child.prepare(object : MediaPeriod.Callback {
      override fun onPrepared(mediaPeriod: MediaPeriod) { callback.onPrepared(this@DecodeAheadPeriod) }
      override fun onContinueLoadingRequested(source: MediaPeriod) { callback.onContinueLoadingRequested(this@DecodeAheadPeriod) }
    }, positionUs)
  }
  override fun selectTracks(selections: Array<out ExoTrackSelection?>, mayRetainStreamFlags: BooleanArray, sampleStreams: Array<SampleStream?>, streamResetFlags: BooleanArray, positionUs: Long): Long {
    val previous = sampleStreams.map { it as? DecodeAheadStream }
    for (i in sampleStreams.indices) previous[i]?.let { sampleStreams[i] = it.child }
    val position = child.selectTracks(selections, mayRetainStreamFlags, sampleStreams, streamResetFlags, positionUs)
    streams.clear()
    for (i in sampleStreams.indices) {
      val selected = selections[i]?.selectedFormat
      val stream = sampleStreams[i]
      if (stream != null && selected?.sampleMimeType in setOf(MimeTypes.VIDEO_H264, MimeTypes.VIDEO_H265)) {
        val wrapped = previous[i]?.takeIf { it.child === stream } ?: DecodeAheadStream(stream, startUs, endUs)
        if (streamResetFlags[i]) wrapped.reset()
        sampleStreams[i] = wrapped
        streams += wrapped
      }
    }
    return position
  }
  override fun seekToUs(positionUs: Long): Long { streams.forEach { it.reset() }; return child.seekToUs(positionUs) }
  override fun getBufferedPositionUs(): Long =
    decodeAheadLoadPosition(child.bufferedPositionUs, endUs, streams.any { !it.ended() })
  override fun getNextLoadPositionUs(): Long =
    decodeAheadLoadPosition(child.nextLoadPositionUs, endUs, streams.any { !it.ended() })
}

// The outer clipping period must keep requesting data until the reference tail is consumed.
// Otherwise a temporarily empty video queue at the endpoint is mistaken for permanent EOS.
internal fun decodeAheadLoadPosition(positionUs: Long, endUs: Long, waitingForReferences: Boolean): Long =
  if (waitingForReferences && positionUs >= endUs) endUs - 1 else positionUs

/** H.264/HEVC allow at most 16 reordered pictures; 32 consecutive outside samples drains the tail. */
internal class DecodeAheadBoundary(private val startUs: Long, private val endUs: Long) {
  private var outside = 0
  fun reset() { outside = 0 }
  fun finish() { outside = 32 }
  fun ended(): Boolean = outside >= 32
  fun timestamp(timeUs: Long, consume: Boolean): Long {
    if (timeUs < endUs) { if (consume) outside = 0; return timeUs }
    if (consume) outside++
    // Media3's Transformer video renderer ignores DECODE_ONLY flags but explicitly drops pre-start PTS.
    // H.264/HEVC references use picture order, so their decoder-only timestamp can remain outside the cut.
    return startUs - 1
  }
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal class DecodeAheadStream(val child: SampleStream, startUs: Long, endUs: Long) : SampleStream by child {
  private val boundary = DecodeAheadBoundary(startUs, endUs)
  fun reset() = boundary.reset()
  fun ended(): Boolean = boundary.ended()
  override fun isReady(): Boolean = boundary.ended() || child.isReady
  override fun readData(formatHolder: FormatHolder, buffer: DecoderInputBuffer, readFlags: Int): Int {
    if (boundary.ended()) { buffer.clear(); buffer.addFlag(C.BUFFER_FLAG_END_OF_STREAM); return C.RESULT_BUFFER_READ }
    val result = child.readData(formatHolder, buffer, readFlags)
    if (result == C.RESULT_BUFFER_READ) {
      if (buffer.isEndOfStream) {
        if (readFlags and SampleStream.FLAG_PEEK == 0) boundary.finish()
      } else {
        val timestamp = boundary.timestamp(buffer.timeUs, readFlags and SampleStream.FLAG_PEEK == 0)
        if (timestamp != buffer.timeUs) buffer.timeUs = timestamp
      }
    }
    return result
  }
}
