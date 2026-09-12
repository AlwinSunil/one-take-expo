package com.onetake.captions

/** Hysteresis keeps the label stable around the delayed threshold. */
internal fun recognitionDelayed(wasDelayed: Boolean, lagMs: Long): Boolean =
  if (wasDelayed) lagMs >= 250 else lagMs > 1_000
