package com.onetake.vision

import java.nio.ByteBuffer

internal object FaceExposure {
  fun sample(buffer: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int, rotation: Int, face: VisionFaceBounds?): Map<String, Double> {
    if (face == null || width <= 0 || height <= 0 || rowStride <= 0 || pixelStride <= 0) return emptyMap()
    val radiusX = (face.right - face.left) * 0.38f
    val radiusY = (face.bottom - face.top) * 0.38f
    if (radiusX <= 0 || radiusY <= 0) return emptyMap()
    val centerX = (face.left + face.right) / 2
    val centerY = (face.top + face.bottom) / 2
    var count = 0; var sum = 0.0; var bright = 0; var dark = 0
    for (y in 0 until height step 8) for (x in 0 until width step 8) {
      val nx = x.toFloat() / width; val ny = y.toFloat() / height
      val point = when (rotation) { 90 -> Pair(1f - ny, nx); 180 -> Pair(1f - nx, 1f - ny); 270 -> Pair(ny, 1f - nx); else -> Pair(nx, ny) }
      val dx = (point.first-centerX)/radiusX; val dy = (point.second-centerY)/radiusY
      // The central ellipse excludes bright background around a face's box.
      if (dx*dx+dy*dy > 1) continue
      val index = buffer.position().toLong() + y.toLong()*rowStride + x.toLong()*pixelStride
      if (index < 0 || index >= buffer.limit()) continue
      val value = buffer.get(index.toInt()).toInt() and 255
      count++; sum += value/255.0
      // Camera Y planes can use video-range white (235), not full-range 255.
      if (value >= 230) bright++
      if (value <= 28) dark++
    }
    if (count < 24) return emptyMap()
    return mapOf("mean" to sum/count, "clipped" to bright.toDouble()/count, "dark" to dark.toDouble()/count)
  }
}
