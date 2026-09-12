package com.onetake.media

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.CompositionPlayer
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import kotlinx.coroutines.*

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class MediaCutPreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onState by EventDispatcher()
  private val handler = Handler(Looper.getMainLooper())
  private val surface = PlayerView(context).apply { useController = false; setBackgroundColor(android.graphics.Color.BLACK) }
  private var player: CompositionPlayer? = null
  private var source = ""
  private var pendingSeek = 0.0
  private var loadJob: Job? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var loadedSource: String? = null
  private var wantsPlay = false
  private val ticker = object : Runnable {
    override fun run() {
      player?.let { onState(mapOf("position" to it.currentPosition / 1000.0, "duration" to it.duration.coerceAtLeast(0) / 1000.0, "playing" to it.isPlaying)) }
      handler.postDelayed(this, 100)
    }
  }
  init { addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) { surface.layout(0, 0, right - left, bottom - top) }
  fun setSegments(value: String) {
    if (value == source && player != null) return
    source = value
    if (isAttachedToWindow) load()
  }
  private fun load() {
    if (source.isEmpty() || (player != null && loadedSource == source)) return
    loadJob?.cancel()
    surface.player = null; player?.release(); player = null; loadedSource = null
    val requestedSource = source
    val loadStarted = android.os.SystemClock.elapsedRealtime()
    loadJob = scope.launch {
    try {
      val composition = withContext(Dispatchers.IO) { MediaComposition.build(context, MediaExportRequestParser.parseJson(JSONObject(requestedSource))) }
      if (!isAttachedToWindow || source != requestedSource) return@launch
      val next = CompositionPlayer.Builder(context).setMediaSourceFactory(DecodeAheadMediaSourceFactory(context)).build()
      player = next; loadedSource = source; surface.player = next
      next.addListener(object : Player.Listener {
        private var reportedFirstFrame = false
        override fun onPlaybackStateChanged(state: Int) {
          if (player === next) onState(mapOf("ready" to (state == Player.STATE_READY), "ended" to (state == Player.STATE_ENDED), "playing" to next.isPlaying))
        }
        override fun onRenderedFirstFrame() {
          // Media3 also sends this callback after seeking or replacing the output surface.
          if (player !== next || reportedFirstFrame) return
          reportedFirstFrame = true
          onState(mapOf("firstFrameMs" to (android.os.SystemClock.elapsedRealtime() - loadStarted)))
        }
        override fun onPlayerError(error: PlaybackException) {
          if (player === next) onState(mapOf("error" to "This cut could not play. Try the original recording."))
        }
      })
      next.setComposition(composition); next.prepare(); next.seekTo((pendingSeek * 1000).toLong()); next.playWhenReady = wantsPlay
    } catch (cancelled: CancellationException) { throw cancelled
    } catch (error: Exception) {
      surface.player = null; player?.release(); player = null; loadedSource = null
      onState(mapOf("error" to (error.message ?: "This cut could not play.")))
    }
  }
  }
  fun setPlaying(value: Boolean) {
    wantsPlay = value
    player?.let { current ->
      // A repeated zero seek prop may not cross the React Native bridge.
      if (value && current.playbackState == Player.STATE_ENDED) current.seekTo(0)
      current.playWhenReady = value
    }
  }
  fun seek(value: Double) { if (!value.isFinite()) return; pendingSeek = value.coerceAtLeast(0.0); player?.seekTo((pendingSeek * 1000).toLong()) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); load(); handler.post(ticker) }
  override fun onDetachedFromWindow() { loadJob?.cancel(); wantsPlay = false; handler.removeCallbacksAndMessages(null); surface.player = null; player?.release(); player = null; loadedSource = null; super.onDetachedFromWindow() }
}
