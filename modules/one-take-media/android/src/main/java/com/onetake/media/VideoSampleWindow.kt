package com.onetake.media

/** Compressed samples are in decode order, so an outside reference can precede an in-cut B-frame. */
internal fun videoWindowHasSample(timesUs: Sequence<Long>, startUs: Long, endUs: Long): Boolean {
  var beyond = 0
  for (timeUs in timesUs) {
    if (timeUs < 0) return false
    if (timeUs >= startUs && timeUs < endUs) return true
    if (timeUs >= endUs) {
      if (++beyond >= 32) return false
    } else beyond = 0
  }
  return false
}
