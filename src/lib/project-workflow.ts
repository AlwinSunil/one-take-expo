import type { Project, TranscriptSeg } from './session';
import { createScriptLine, createTranscriptSegment, deriveReviewState, type WorkflowInput } from './transcript-workflow.ts';

export function projectSegments(project: Project) {
  return project.transcript.filter(s => s.t1 > s.t0).map((s, i) => createTranscriptSegment({
    ...s, id: s.id || `${project.id}:${i}`, isFinal: s.isFinal ?? true,
    manualCorrection: s.manualCorrection ?? s.correctedText ?? null,
  }));
}

export function projectScriptLines(project: Project) {
  return project.scriptLines ?? (project.script?.match(/[^.!?\n]+[.!?]?/g) ?? [])
    .map((text, i) => createScriptLine({ id: `${project.id}:line:${i}`, text }));
}

export function projectReview(project: Project) {
  const segments = projectSegments(project);
  const lines = projectScriptLines(project);
  const unclearIds = new Set(project.transcript.filter(segment => segment.t1 > segment.t0)
    .flatMap((segment, index) => segment.needsListening ? [segment.id || `${project.id}:${index}`] : []));
  const pendingUris = new Set(project.recordings?.filter(recording => recording.evidenceStatus === 'pending').map(recording => recording.mediaUri));
  return deriveScopedReview({ lines, segments, decisions: project.reviewDecisions,
    silences: project.quietIntervals?.map((s, i) => ({ ...s, id: `${project.id}:quiet:${i}`, verifiedBoundary: false })),
    takes: project.takes?.map(take => ({ ...take, quality: take.quality === 'clean' && take.transcriptSegmentIds.some(id => unclearIds.has(id)) ? 'scratched' as const : take.quality, playable: take.playable && !pendingUris.has(take.mediaUri ?? '') && !project.unavailableTakeIds?.includes(take.id) })) ?? segments.map(s => ({ id: `take:${s.id}`, t0: s.t0, t1: s.t1, mediaUri: project.videoUri,
      playable: !!project.videoUri && !project.mediaMissing, quality: unclearIds.has(s.id) ? 'scratched' as const : 'clean' as const,
      inFrame: false, transcriptSegmentIds: [s.id] })),
  });
}

/** Scope limits coverage eligibility, never the source audio interval or transcript history. */
export function deriveScopedReview(input: WorkflowInput) {
  const baseline = deriveReviewState(input);
  const scoped = input.takes as NonNullable<Project['takes']>;
  if (!scoped.some(take => take.eligibleLineIds !== undefined)) return baseline;
  const groups = new Map<string, ReturnType<typeof deriveReviewState>>();
  const lines = baseline.lines.map((line, lineIndex) => {
    const indices = scoped.flatMap((take, index) => take.eligibleLineIds === undefined || take.eligibleLineIds.includes(line.id) ? [index] : []);
    if (indices.length === scoped.length) return line;
    const key = indices.join(',');
    let group = groups.get(key);
    if (!group) {
      group = deriveReviewState({ ...input, takes: indices.map(index => scoped[index]) });
      groups.set(key, group);
    }
    return group.lines[lineIndex];
  });
  return { ...baseline, lines,
    safeToWrap: lines.every(line => line.status === 'covered') && baseline.unresolvedRequiredActionCueIds.length === 0,
  };
}

/** Different recognition jobs may segment audio differently; IDs are not cross-job identities. */
export function replaceWithRefined(project: Project, incoming: TranscriptSeg[]): Project {
  const candidate = validateRefinementPayload(incoming);
  const ready = { status: 'ready' as const, model: 'Moonshine Tiny Streaming' };

  // An empty recognizer result is not evidence that existing speech vanished.
  // Keep the current timeline and expose the empty candidate for comparison.
  if (candidate.length === 0) {
    return { ...project, refinementCandidate: candidate, refinement: ready };
  }

  const hasReviewAnnotations = project.transcript.some(segment =>
    segment.manualCorrection != null || segment.correctedText != null || segment.needsListening === true,
  );

  // Independent recognition jobs do not promise stable ids or identical
  // boundaries. Once a creator has annotated any caption, merging by time can
  // duplicate speech or move an edit to the wrong utterance. Retain the whole
  // current timeline and keep the complete candidate for explicit comparison.
  if (hasReviewAnnotations) {
    return { ...project, refinementCandidate: candidate, refinement: ready };
  }

  const captionRevision = (project.captionRevision ?? 0) + 1;
  const transcript = candidate.map((segment, index) => ({
    ...segment,
    id: `${project.id}:refined:${index}`,
    revision: captionRevision,
    timingSource: 'saved-audio' as const,
    source: 'refined' as const,
  }));
  return {
    ...project,
    rawTranscript: project.transcript,
    refinementCandidate: candidate,
    previousReviewDecisions: project.reviewDecisions,
    cutsReviewed: false,
    transcript,
    captionRevision,
    refinement: ready,
    reviewDecisions: [],
  };
}

function validateRefinementPayload(value: unknown): TranscriptSeg[] {
  if (!Array.isArray(value)) throw new TypeError('Refined transcript must be an array.');
  return value.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new TypeError(`Refined transcript segment ${index + 1} is invalid.`);
    }
    const segment = value as TranscriptSeg;
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0) {
      throw new RangeError(`Refined transcript segment ${index + 1} must have finite positive seconds.`);
    }
    if (typeof segment.text !== 'string' || !segment.text.trim()) {
      throw new TypeError(`Refined transcript segment ${index + 1} text must be a non-empty string.`);
    }
    if (segment.id !== undefined && (typeof segment.id !== 'string' || !segment.id.trim())) {
      throw new TypeError(`Refined transcript segment ${index + 1} id is invalid.`);
    }
    if (segment.isFinal !== undefined && typeof segment.isFinal !== 'boolean') {
      throw new TypeError(`Refined transcript segment ${index + 1} isFinal is invalid.`);
    }
    return { ...segment };
  });
}

export function toggleCaptionListening(project: Project, segmentId: string | number): Project {
  const index = typeof segmentId === 'number' ? segmentId : project.transcript.findIndex(segment => segment.id === segmentId);
  if (!Number.isInteger(index) || index < 0 || index >= project.transcript.length) throw new Error('This caption is no longer available.');
  return { ...project, cuts: undefined, reviewSegments: undefined, cutsReviewed: false,
    transcript: project.transcript.map((segment, position) => position === index ? { ...segment, needsListening: !segment.needsListening } : segment) };
}
