/** Saved cut boundaries use file metadata, not the player's shorter/float-rounded timeline. */
export function sourceDuration(verified: number | undefined, saved: number | undefined, playback = 0): number {
  return [verified, saved, playback].find(value => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? 0;
}

export function sourceRangeFits(range: { t0: number; t1: number }, duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(range.t0) && Number.isFinite(range.t1)
    && range.t0 >= 0 && range.t1 > range.t0 && range.t1 <= duration;
}
