import type { Project } from './session';
import { buildFramingPlan, type NativeFramingCrop } from './t1-framing.ts';

export type FramingSegment = { uri: string; t0: number; t1: number; takeId?: string; crop?: NativeFramingCrop };
/** Shared preview/export projection. Stored choices never bypass the caller's runtime gate. */
export function applyProjectFraming<T extends FramingSegment>(project: Project, segments: readonly T[], enabled = false): T[] {
  return segments.map(segment => {
    const { crop: _previousCrop, ...original } = segment;
    if (!enabled || project.framing?.enabled !== true) return original as T;
    const recording = project.recordings?.find(item => item.mediaUri === segment.uri);
    const sourceMediaId = recording?.id ?? (segment.uri === project.videoUri ? project.id : '');
    if (!sourceMediaId) return original as T;
    const available = project.availableMediaUris?.includes(segment.uri) ?? (segment.uri === project.videoUri && project.mediaMissing === false);
    const decision = buildFramingPlan({ sourceMediaId, enabled: true, suggestions: project.framing.suggestions,
      cuts: [{ sourceMediaId, takeId: segment.takeId, startSec: segment.t0, endSec: segment.t1, mediaAvailable: available }] }).cuts[0];
    return (decision.mode === 'reframed' ? { ...original, crop: decision.nativeCrop } : original) as T;
  });
}
