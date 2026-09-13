package com.onetake.media

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Crop
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects

internal data class MediaSourceSegment(
  val uri: String,
  val cut: SourceCut,
  val captions: List<SourceCaption>,
  val crop: NativeFramingCrop? = null,
)

internal fun mapSegmentCaptions(segments: List<MediaSourceSegment>): List<MappedCaption> {
  var offset = 0L
  return segments.flatMap { segment ->
    val mapped = MediaExportTimeline.mapCaptions(segment.captions, listOf(segment.cut))
      .map { it.copy(startUs = it.startUs + offset, endUs = it.endUs + offset) }
    offset += (MediaExportTimeline.toMillis(segment.cut.t1) - MediaExportTimeline.toMillis(segment.cut.t0)) * 1_000
    mapped
  }
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
internal object MediaComposition {
  fun build(context: Context, request: MediaExportRequest): Composition {
    val durations = mutableMapOf<String, Long>()
    fun duration(uri: String): Long = durations.getOrPut(uri) {
      require(Uri.parse(uri).scheme in setOf("file", "content", "android.resource")) { "Only local recordings are supported" }
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(context, Uri.parse(uri))
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
          ?: error("Could not read recording duration")
      } finally { retriever.release() }
    }
    val segments = request.segments.ifEmpty {
      val cuts = request.cuts.ifEmpty { listOf(SourceCut(0.0, duration(request.sourceUri) / 1000.0)) }
      cuts.map { MediaSourceSegment(request.sourceUri, it, request.captions) }
    }
    require(segments.isNotEmpty() && segments.size <= MediaExportTimeline.MAX_CUTS) { "Choose playable segments" }
    val captions = mapSegmentCaptions(segments)
    val items = segments.map { segment ->
      MediaExportTimeline.validateCuts(listOf(segment.cut))
      val durationMs = duration(segment.uri)
      require(MediaExportTimeline.toMillis(segment.cut.t1) <= durationMs + 1) { "A cut extends beyond its source recording" }
      val item = MediaItem.Builder().setUri(segment.uri).setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(MediaExportTimeline.toMillis(segment.cut.t0))
          .setEndPositionMs(MediaExportTimeline.toMillis(segment.cut.t1)).build()
      ).build()
      val videoEffects = buildList {
        segment.crop?.let { crop -> add(Crop(crop.left.toFloat(), crop.right.toFloat(), crop.bottom.toFloat(), crop.top.toFloat())) }
        add(Presentation.createForWidthAndHeight(720, 1280, Presentation.LAYOUT_SCALE_TO_FIT))
      }
      EditedMediaItem.Builder(item).setDurationUs(durationMs * 1_000)
        .setEffects(Effects(emptyList(), videoEffects))
        .build()
    }
    val sequence = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)).addItems(items).build()
    val effects = if (captions.isEmpty()) Effects(emptyList(), emptyList()) else
      Effects(emptyList(), listOf(OverlayEffect(listOf(MediaExportRunner.TimedCaptionOverlay(captions)))))
    return Composition.Builder(sequence).setEffects(effects)
      .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL).build()
  }
}
