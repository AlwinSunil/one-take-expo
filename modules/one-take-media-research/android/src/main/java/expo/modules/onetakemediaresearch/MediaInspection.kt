package expo.modules.onetakemediaresearch

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Container evidence only: sample timestamps do not establish audible or perceptual sync. */
object MediaInspection {
  fun inspect(uriString: String): String {
    val uri = Uri.parse(uriString)
    require(uri.scheme == "file" && uri.path != null) { "Choose a local research recording." }
    val source = File(uri.path!!)
    require(source.isFile) { "The media file is missing." }
    val result = JSONObject().put("uri", uriString).put("sizeBytes", source.length())
      .put("probe", "Android MediaExtractor + MediaMetadataRetriever; compressed samples, not decoded audio")
    val metadata = MediaMetadataRetriever()
    try {
      metadata.setDataSource(source.path)
      for ((name, key) in listOf(
        "durationMs" to MediaMetadataRetriever.METADATA_KEY_DURATION,
        "width" to MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH,
        "height" to MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT,
        "rotationDegrees" to MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION,
        "bitrate" to MediaMetadataRetriever.METADATA_KEY_BITRATE,
      )) result.put(name, metadata.extractMetadata(key)?.toLongOrNull() ?: JSONObject.NULL)
      result.put("hasAudio", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes")
      result.put("hasVideo", metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes")
    } finally { metadata.release() }
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(source.path)
      val tracks = JSONArray()
      val counts = LongArray(extractor.trackCount)
      val first = LongArray(extractor.trackCount) { Long.MAX_VALUE }
      val last = LongArray(extractor.trackCount) { Long.MIN_VALUE }
      for (index in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(index)
        val track = JSONObject().put("index", index).put("mime", format.getString(MediaFormat.KEY_MIME))
        for ((name, key) in listOf(
          "durationUs" to MediaFormat.KEY_DURATION,
          "width" to MediaFormat.KEY_WIDTH,
          "height" to MediaFormat.KEY_HEIGHT,
          "sampleRate" to MediaFormat.KEY_SAMPLE_RATE,
          "channelCount" to MediaFormat.KEY_CHANNEL_COUNT,
        )) {
          if (format.containsKey(key)) track.put(name, if (key == MediaFormat.KEY_DURATION) format.getLong(key) else format.getInteger(key))
        }
        tracks.put(track)
        extractor.selectTrack(index)
      }
      while (extractor.sampleTrackIndex >= 0) {
        val index = extractor.sampleTrackIndex
        val time = extractor.sampleTime
        counts[index]++
        first[index] = minOf(first[index], time)
        last[index] = maxOf(last[index], time)
        if (!extractor.advance()) break
      }
      for (index in 0 until tracks.length()) {
        tracks.getJSONObject(index).put("sampleCount", counts[index])
          .put("firstPresentationTimeUs", if (counts[index] == 0L) JSONObject.NULL else first[index])
          .put("lastPresentationTimeUs", if (counts[index] == 0L) JSONObject.NULL else last[index])
      }
      return result.put("tracks", tracks).toString()
    } finally { extractor.release() }
  }
}
