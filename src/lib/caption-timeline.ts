/**
 * A caption interval in the source media timeline.
 *
 * `isFinal` is optional so the helper can consume both the persisted
 * transcript shape and the already-filtered export shape.
 */
export interface CaptionTimelineInput {
  t0: number;
  t1: number;
  text: string;
  isFinal?: boolean;
}

/** A non-overlapping visual cue suitable for preview or native export. */
export interface CaptionTimelineCue {
  t0: number;
  t1: number;
  text: string;
}

/**
 * Partition source captions at every start and end boundary.
 *
 * A visual cue contains every source caption active during that interval.
 * When more than one caption is active, their text is kept in stable source
 * order and joined with a newline.  The function never invents word timing,
 * clamps an interval, or fills a gap with synthetic text.
 *
 * Input order is used as the final tie breaker after source time ordering, so
 * equal or otherwise ambiguous starts remain deterministic.
 */
export function partitionCaptionTimeline(
  captions: readonly CaptionTimelineInput[],
): CaptionTimelineCue[] {
  if (!Array.isArray(captions)) {
    throw new TypeError('Caption timeline must be an array.');
  }

  const usable = captions.map((caption, index) => {
    validateCaption(caption, index);
    if (caption.isFinal === false) return null;
    const text = caption.text.trim();
    if (!text) return null;
    return { t0: caption.t0, t1: caption.t1, text, sourceIndex: index };
  }).filter((caption): caption is { t0: number; t1: number; text: string; sourceIndex: number } => caption !== null);

  const ordered = [...usable].sort((a, b) =>
    a.t0 - b.t0 || a.t1 - b.t1 || a.sourceIndex - b.sourceIndex,
  );
  const boundaries = [...new Set(ordered.flatMap(caption => [caption.t0, caption.t1]))]
    .sort((a, b) => a - b);
  const cues: CaptionTimelineCue[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const t0 = boundaries[index];
    const t1 = boundaries[index + 1];
    if (t1 <= t0) continue;
    const active = ordered.filter(caption => caption.t0 < t1 && caption.t1 > t0);
    if (active.length === 0) continue;
    cues.push({ t0, t1, text: active.map(caption => caption.text).join('\n') });
  }

  return cues;
}

/**
 * Return the cue visible at a source time.
 *
 * Cues use the half-open interval `[t0, t1)`, matching media timeline
 * selection and ensuring a boundary belongs to the following cue.
 */
export function activeCaptionAt(
  cues: readonly CaptionTimelineCue[],
  time: number,
): CaptionTimelineCue | undefined {
  if (!Number.isFinite(time)) return undefined;
  return cues.find(cue => cue.t0 <= time && time < cue.t1);
}

function validateCaption(caption: CaptionTimelineInput, index: number): void {
  if (!caption || typeof caption !== 'object') {
    throw new TypeError(`Caption ${index + 1} is invalid.`);
  }
  if (!Number.isFinite(caption.t0) || !Number.isFinite(caption.t1) || caption.t0 < 0 || caption.t1 <= caption.t0) {
    throw new RangeError(`Caption interval ${index + 1} is invalid.`);
  }
  if (caption.isFinal !== undefined && typeof caption.isFinal !== 'boolean') {
    throw new TypeError(`Caption ${index + 1} finality is invalid.`);
  }
  if (typeof caption.text !== 'string') {
    throw new TypeError(`Caption ${index + 1} text is invalid.`);
  }
}
