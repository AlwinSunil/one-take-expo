import { mapExportCaptions, validateExportCaptions, validateExportCuts } from '../../modules/one-take-media/timeline.ts';

import { applyProjectFraming } from './t1-framing-selection.ts';
import { transcriptForSource } from './review-source.ts';
import { partitionCaptionTimeline } from './caption-timeline.ts';
import type { Project, TranscriptSeg } from './session';

export type ExportCut = { t0: number; t1: number };
export type ExportCaption = ExportCut & { text: string };
export type ExportSegment = ExportCut & { uri: string; captions?: ExportCaption[]; takeId?: string; crop?: import('./t1-framing').NativeFramingCrop };
export type CaptionTiming = 'none' | 'saved-audio' | 'live-estimate' | 'mixed';

export type ExportPlanErrorCode =
  | 'empty-timeline'
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
  timelineRevision?: number;
  burnIntoExport?: boolean;
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
export function buildExportPlan(project: Project, start: number, end: number, framingEnabled = false, burnIntoExport = true): ExportPlan {
  if (project.reviewSegments !== undefined) {
    if (!project.cutsReviewed) throw new ExportPlanError('unreviewed-cuts', 'Review and accept each cut before exporting.');
    if (!Array.isArray(project.reviewSegments) || project.reviewSegments.length === 0) throw new ExportPlanError('invalid-cuts', 'Choose at least one segment.');
    const segments = project.reviewSegments.map(segment => {
      const sourceTranscript = transcriptForSource(project, segment.uri);
      const plan = buildExportPlan({ ...project, reviewSegments: undefined, videoUri: segment.uri, cuts: undefined,
        mediaMissing: project.availableMediaUris ? !project.availableMediaUris.includes(segment.uri) : project.mediaMissing,
        transcript: sourceTranscript.length > 0 ? sourceTranscript : segment.captions ?? [] }, segment.t0, segment.t1, false, burnIntoExport);
      return { uri: segment.uri, t0: segment.t0, t1: segment.t1, captions: plan.captions, takeId: segment.takeId };
    });
    if (segments.length > 100) throw new ExportPlanError('invalid-cuts', 'Too many export segments.');
    return { sourceUri: segments[0].uri, cuts: [], captions: [], segments: applyProjectFraming(project, segments, framingEnabled),
      captionTiming: segments.some(segment => segment.captions.length) ? 'live-estimate' : 'none',
      hasEstimatedCaptions: segments.some(segment => segment.captions.length > 0) };
  }
  const sourceUri = project.videoUri;
  if (project.mediaMissing || typeof sourceUri !== 'string' || !sourceUri.trim()
    || (Array.isArray(project.availableMediaUris) && !project.availableMediaUris.includes(sourceUri))) {
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

  const captionBuild = buildCaptions(burnIntoExport ? transcriptForSource(project, sourceUri) : []);
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

/** Structural consumer of B's published resolveTimeline output (handoff 904ccc5).
 * This adapter never selects, excludes, orders or edits clips.
 * Replace the structural type import only after B's implementation merges.
 */
export interface CaptionExportSequence {
  revision: number;
  segments: readonly {
    clipId: string; sourceId: string; uri: string; t0: number; t1: number;
    outputT0: number; outputT1: number; takeId?: string;
  }[];
  duration: number;
  issues: readonly unknown[];
}

export function buildTimelineExportPlan(
  project: Project, sequence: CaptionExportSequence, burnIntoExport: boolean, framingEnabled = false,
): ExportPlan {
  if (!Number.isSafeInteger(sequence.revision) || sequence.revision < 0 || sequence.issues.length) {
    throw new ExportPlanError('invalid-cuts', 'Resolve timeline issues before exporting.');
  }
  if (!sequence.segments.length) {
    throw new ExportPlanError('empty-timeline', 'Include at least one clip before exporting.');
  }
  if (sequence.segments.length > 100) throw new ExportPlanError('invalid-cuts', 'Too many export segments.');
  let offset = 0;
  const timings: CaptionTiming[] = [];
  const segments = sequence.segments.map(segment => {
    const recording = project.recordings?.find(source => source.id === segment.sourceId);
    if (!recording || recording.mediaUri !== segment.uri) {
      throw new ExportPlanError('missing-source', 'The timeline source is unavailable.');
    }
    if (!Number.isFinite(segment.outputT0) || !Number.isFinite(segment.outputT1)
      || Math.abs(segment.outputT0 - offset) > 1e-6
      || Math.abs(segment.outputT1 - segment.outputT0 - (segment.t1 - segment.t0)) > 1e-6) {
      throw new ExportPlanError('invalid-cuts', 'The timeline output intervals are inconsistent.');
    }
    // Source identity, not overlapping timestamps or fallback segment text, owns captions.
    if (typeof recording.duration === 'number' && segment.t1 > recording.duration) {
      throw new ExportPlanError('invalid-cuts', 'The timeline exceeds its source duration.');
    }
    const transcript = transcriptForSource(project, segment.uri)
      .filter(cue => cue.t0 < segment.t1 && cue.t1 > segment.t0);
    const plan = buildExportPlan({ ...project, videoUri: segment.uri, reviewSegments: undefined,
      cuts: undefined, transcript, mediaMissing: false }, segment.t0, segment.t1, false, burnIntoExport);
    timings.push(plan.captionTiming);
    offset = segment.outputT1;
    return { uri: segment.uri, t0: segment.t0, t1: segment.t1, takeId: segment.takeId,
      captions: plan.captions.filter(cue => cue.t0 < segment.t1 && cue.t1 > segment.t0) };
  });
  if (!Number.isFinite(sequence.duration) || Math.abs(offset - sequence.duration) > 1e-6) {
    throw new ExportPlanError('invalid-cuts', 'The timeline duration is inconsistent.');
  }
  const hasEstimatedCaptions = timings.some(timing => timing === 'live-estimate' || timing === 'mixed');
  const hasSaved = timings.some(timing => timing === 'saved-audio' || timing === 'mixed');
  return freezeExportPlan({ timelineRevision: sequence.revision, burnIntoExport,
    sourceUri: segments[0].uri, cuts: [], captions: [],
    segments: applyProjectFraming(project, segments, framingEnabled),
    captionTiming: hasEstimatedCaptions ? hasSaved ? 'mixed' : 'live-estimate' : hasSaved ? 'saved-audio' : 'none',
    hasEstimatedCaptions });
}

/** Capture values before any confirmation dialog, await or later editor mutation. */
export function freezeExportPlan(plan: ExportPlan): ExportPlan {
  const clone = JSON.parse(JSON.stringify(plan)) as ExportPlan;
  function freeze(value: object): void {
    Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
    Object.freeze(value);
  }
  freeze(clone);
  return clone;
}

/** Editor overlay only; export burn-in never reads this display preference. */
export function buildTimelineEditorCaptions(
  project: Project, sequence: CaptionExportSequence, showInEditor: boolean,
): ExportCaption[] {
  if (!showInEditor || !sequence.segments.length || sequence.issues.length) return [];
  const plan = buildTimelineExportPlan(project, sequence, true);
  return plan.segments!.flatMap((segment, index) => mapExportCaptions(segment.captions ?? [], [segment])
    .map(cue => ({ ...cue, t0: cue.t0 + sequence.segments[index].outputT0,
      t1: cue.t1 + sequence.segments[index].outputT0 })));
}
