import { validateExportCaptions, validateExportCuts } from '../../modules/one-take-media/timeline.ts';

import { applyProjectFraming } from './t1-framing-selection.ts';
import { transcriptForSource } from './review-source.ts';
import { partitionCaptionTimeline } from './caption-timeline.ts';
import type { Project, TranscriptSeg } from './session';

export type ExportCut = { t0: number; t1: number };
export type ExportCaption = ExportCut & { text: string };
export type ExportSegment = ExportCut & { uri: string; captions?: ExportCaption[]; takeId?: string; crop?: import('./t1-framing').NativeFramingCrop };
export type CaptionTiming = 'none' | 'saved-audio' | 'live-estimate' | 'mixed';

export type ExportPlanErrorCode =
  | 'missing-source'
  | 'invalid-trim'
  | 'invalid-cuts'
  | 'unreviewed-cuts'
  | 'invalid-caption'
  | 'caption-overlap';

export class ExportPlanError extends Error {
  readonly code: ExportPlanErrorCode;

  constructor(code: ExportPlanErrorCode, message: string) {
    super(message);
    this.name = 'ExportPlanError';
    this.code = code;
  }
}

export interface ExportPlan {
  segments?: ExportSegment[];
  sourceUri: string;
  /** Source-relative cuts in the exact output order used by the editor. */
  cuts: ExportCut[];
  /** Source-relative, final, non-overlapping captions for the native module. */
  captions: ExportCaption[];
  captionTiming: CaptionTiming;
  hasEstimatedCaptions: boolean;
}

/**
 * Build the one source-of-truth request shared by preview and export.
 * Explicit project cuts take precedence over the current trim.  Otherwise the
 * editor's selected trim becomes one source-relative cut.
 */
export function buildExportPlan(project: Project, start: number, end: number, framingEnabled = false): ExportPlan {
  if (project.reviewSegments !== undefined) {
    if (!project.cutsReviewed) throw new ExportPlanError('unreviewed-cuts', 'Review and accept each cut before exporting.');
    if (!Array.isArray(project.reviewSegments) || project.reviewSegments.length === 0) throw new ExportPlanError('invalid-cuts', 'Choose at least one segment.');
    const segments = project.reviewSegments.map(segment => {
      const plan = buildExportPlan({ ...project, reviewSegments: undefined, videoUri: segment.uri, cuts: undefined,
        mediaMissing: project.availableMediaUris ? !project.availableMediaUris.includes(segment.uri) : project.mediaMissing,
        transcript: project.transcript.length ? transcriptForSource(project, segment.uri) : segment.captions ?? [] }, segment.t0, segment.t1);
      return { uri: segment.uri, t0: segment.t0, t1: segment.t1, captions: plan.captions, takeId: segment.takeId };
    });
    if (segments.length > 100) throw new ExportPlanError('invalid-cuts', 'Too many export segments.');
    return { sourceUri: segments[0].uri, cuts: [], captions: [], segments: applyProjectFraming(project, segments, framingEnabled),
      captionTiming: segments.some(segment => segment.captions.length) ? 'live-estimate' : 'none',
      hasEstimatedCaptions: segments.some(segment => segment.captions.length > 0) };
  }
  const sourceUri = project.videoUri;
  if (project.mediaMissing || typeof sourceUri !== 'string' || !sourceUri.trim()) {
    throw new ExportPlanError('missing-source', 'The original recording is unavailable.');
  }
  const scheme = sourceUri.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLocaleLowerCase();
  if (scheme && !['file', 'content', 'android.resource'].includes(scheme)) {
    throw new ExportPlanError('missing-source', 'Export accepts only local recording media.');
  }

  const cuts = project.cuts !== undefined
    ? cloneCuts(project.cuts, 'project cut')
    : [{ t0: start, t1: end }];
  if (project.cuts !== undefined && cuts.length > 0 && !(project as Project & { cutsReviewed?: boolean }).cutsReviewed) {
    throw new ExportPlanError('unreviewed-cuts', 'Review and accept each cut before exporting.');
  }
  if (project.cuts === undefined && (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)) {
    throw new ExportPlanError('invalid-trim', 'Choose a valid trim range before exporting.');
  }
  try {
    validateExportCuts(cuts);
  } catch (error) {
    throw new ExportPlanError('invalid-cuts', error instanceof Error ? error.message : 'The selected cuts are invalid.');
  }

  const captionBuild = buildCaptions(transcriptForSource(project, sourceUri));
  let captions: ExportCaption[];
  try {
    captions = validateExportCaptions(partitionCaptionTimeline(captionBuild.captions));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The caption intervals are invalid.';
    const code: ExportPlanErrorCode = /overlap/i.test(message) ? 'caption-overlap' : 'invalid-caption';
    throw new ExportPlanError(code, code === 'caption-overlap'
      ? 'Caption timing overlaps. Recheck the saved audio before exporting captions.'
      : message);
  }

  return {
    sourceUri,
    cuts,
    captions,
    captionTiming: captionBuild.captionTiming,
    hasEstimatedCaptions: captionBuild.hasEstimatedCaptions,
  };
}

interface CaptionBuild {
  captions: ExportCaption[];
  captionTiming: CaptionTiming;
  hasEstimatedCaptions: boolean;
}

function buildCaptions(segments: readonly TranscriptSeg[]): CaptionBuild {
  if (!Array.isArray(segments)) {
    throw new ExportPlanError('invalid-caption', 'The saved transcript is unreadable.');
  }

  let hasSavedAudio = false;
  let hasEstimated = false;
  const captions: ExportCaption[] = [];
  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0) {
      throw new ExportPlanError('invalid-caption', `Caption interval ${index + 1} is invalid.`);
    }
    if (segment.isFinal === false) return;
    // An empty manual correction is an explicit request to omit this caption.
    // It must not fall back to recognizer text or block an otherwise valid
    // export with a blank caption.
    if (typeof segment.manualCorrection === 'string' && !segment.manualCorrection.trim()) return;
    const text = segment.manualCorrection ?? segment.correctedText ?? segment.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ExportPlanError('invalid-caption', `Caption ${index + 1} has no readable text.`);
    }
    const spoken = sanitizeExportCaption(text);
    if (!spoken) return;
    captions.push({ t0: segment.t0, t1: segment.t1, text: spoken });
    if (segment.timingSource === 'saved-audio') hasSavedAudio = true;
    else hasEstimated = true;
  });

  return {
    captions,
    captionTiming: captions.length === 0
      ? 'none'
      : hasSavedAudio && hasEstimated
        ? 'mixed'
        : hasSavedAudio
          ? 'saved-audio'
          : 'live-estimate',
    hasEstimatedCaptions: hasEstimated,
  };
}

function cloneCuts(value: unknown, label: string): ExportCut[] {
  if (!Array.isArray(value)) {
    throw new ExportPlanError('invalid-cuts', `${label}s must be an array.`);
  }
  return value.map((cut, index) => {
    if (!cut || typeof cut !== 'object') {
      throw new ExportPlanError('invalid-cuts', `${label} ${index + 1} is invalid.`);
    }
    const candidate = cut as { t0?: unknown; t1?: unknown };
    if (typeof candidate.t0 !== 'number' || typeof candidate.t1 !== 'number') {
      throw new ExportPlanError('invalid-cuts', `${label} ${index + 1} must contain numeric times.`);
    }
    return { t0: candidate.t0, t1: candidate.t1 };
  });
}

export function sanitizeExportCaption(text: string): string {
  const spoken = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return /^scratch that[.!?,]*$/i.test(spoken) ? '' : spoken;
}
