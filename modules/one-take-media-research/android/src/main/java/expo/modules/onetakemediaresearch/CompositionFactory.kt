package expo.modules.onetakemediaresearch

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.Crop
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import com.google.common.collect.ImmutableList
import org.json.JSONArray
import java.io.File

@UnstableApi
object CompositionFactory {
  fun build(segments: JSONArray): Composition {
    require(segments.length() in 1..500) { "Choose at least one playable segment." }
    val durations = mutableMapOf<String, Long>()
    val items = (0 until segments.length()).map { index ->
      val segment = segments.getJSONObject(index)
      val uri = android.net.Uri.parse(segment.getString("uri"))
      require(uri.scheme == "file" && File(uri.path!!).isFile) { "A source recording is missing. Restore it and try again." }
      val durationMs = durations.getOrPut(uri.toString()) {
        val metadata = android.media.MediaMetadataRetriever()
        try {
          metadata.setDataSource(uri.path)
          metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            ?: error("Could not read the recording duration.")
        } finally { metadata.release() }
      }
      val start = segment.getDouble("start")
      val end = segment.getDouble("end")
      require(start.isFinite() && end.isFinite() && start >= 0 && end > start) { "The selected interval is invalid." }
      require(end * 1000 <= durationMs + 1) { "The selected interval extends beyond the recording." }
      val media = MediaItem.Builder().setUri(uri).setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder().setStartPositionMs((start * 1000).toLong()).setEndPositionMs((end * 1000).toLong()).build()
      ).build()
      val effects = mutableListOf<Effect>()
      segment.optJSONObject("crop")?.let { crop ->
        val left = crop.getDouble("left").toFloat(); val right = crop.getDouble("right").toFloat()
        val bottom = crop.getDouble("bottom").toFloat(); val top = crop.getDouble("top").toFloat()
        require(left >= -1f && right <= 1f && bottom >= -1f && top <= 1f && left < right && bottom < top) { "Invalid crop." }
        effects.add(Crop(left, right, bottom, top))
      }
      // A single 720p SDR canvas keeps caption size and safe margins identical in preview and export.
      effects.add(Presentation.createForWidthAndHeight(720, 1280, Presentation.LAYOUT_SCALE_TO_FIT))
      val caption = segment.optString("caption").trim()
      if (caption.isNotEmpty()) effects.add(OverlayEffect(ImmutableList.of<TextureOverlay>(captionOverlay(caption))))
      // CompositionPlayer requires the original duration; clipping computes the presentation duration.
      EditedMediaItem.Builder(media).setDurationUs(durationMs * 1000).setEffects(Effects(emptyList(), effects)).build()
    }
    val sequence = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)).addItems(items).build()
    return Composition.Builder(sequence).setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL).build()
  }

  private fun captionOverlay(text: String): BitmapOverlay {
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 32f; typeface = android.graphics.Typeface.create("sans-serif-medium", 0) }
    val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, 592).setAlignment(Layout.Alignment.ALIGN_CENTER).setIncludePad(false).build()
    require(layout.height <= 320) { "This caption is too long. Shorten it or choose smaller caption segments." }
    val bitmap = Bitmap.createBitmap(640, layout.height + 36, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawRoundRect(0f, 0f, 640f, bitmap.height.toFloat(), 16f, 16f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xDD111111.toInt() })
    canvas.save(); canvas.translate(24f, 18f); layout.draw(canvas); canvas.restore()
    val settings = StaticOverlaySettings.Builder().setBackgroundFrameAnchor(0f, -0.72f).setOverlayFrameAnchor(0f, -1f).build()
    return BitmapOverlay.createStaticBitmapOverlay(bitmap, settings)
  }
}
