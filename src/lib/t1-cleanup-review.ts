/**
 * Review-only consumer for the merged speech-control cleanup plans.
 *
 * The producer supplies reasons, evidence, fingerprints, and safe-boundary
 * state.  This module only lets a creator apply an already-prepared removal
 * inside an existing review sequence after current media and identity checks.
 * It never changes the original URI, transcript, raw transcript, or producer
 * plan, and recognition timestamps are never promoted to splice boundaries.
 */

import type { Project } from './session.ts';
import { projectScriptLines } from './project-workflow.ts';
import {
  applyCleanupDecision,
  canPrepareCleanupRemoval,
  prepareCleanupRemoval,
  type CleanupDecision as ProducerCleanupDecision,
  type CleanupEvidence,
  type CleanupSuggestion,
} from '../features/speech-control/cleanup.ts';

export const T1_CLEANUP_REVIEW_VERSION = 1 as const;

export type CleanupReviewSegment = NonNullable<Project['reviewSegments']>[number];

/** Additive Project field. Parent wiring should add `cleanupReview?: T1CleanupReviewState`. */
export type T1CleanupReviewState = Readonly<{
  version: typeof T1_CLEANUP_REVIEW_VERSION;
  projectId: string;
  speechRevision: string;
  /** The explicit prepared sequence before any accepted cleanup decision. */
  baseReviewSegments: readonly CleanupReviewSegment[];
  /** Fingerprint of the currently applied prepared sequence. */
  appliedReviewSegmentsFingerprint: string;
  identities: readonly T1CleanupReviewIdentity[];
  decisions: readonly T1CleanupReviewDecision[];
}>;

export type T1CleanupReviewIdentity = Readonly<{
  recordingId: string;
  mediaUri: string | null;
}>;

export type T1CleanupReviewDecision = Readonly<{
  id: string;
  suggestionId: string;
  recordingId: string;
  action: 'accept' | 'dismiss';
  fingerprint: string;
}>;

export type CleanupReviewProject = Project & {
  cleanupReview?: T1CleanupReviewState;
};

export type CleanupReviewFootage = Readonly<{
  recordingId: string;
  uri: string;
  t0: number;
  t1: number;
}>;

export type CleanupReviewItemStatus =
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'review-only'
  | 'unavailable'
  | 'stale';

export type CleanupReviewItem = Readonly<{
  id: string;
  recordingId: string;
  suggestion: CleanupSuggestion;
  reason: string;
  evidence: readonly CleanupEvidence[];
  decision?: ProducerCleanupDecision;
  status: CleanupReviewItemStatus;
  previewFootage?: CleanupReviewFootage;
  canPreview: boolean;
  canAccept: boolean;
  unavailableReason?: string;
}>;

export type CleanupReviewReportStatus =
  | 'disabled'
  | 'unavailable'
  | 'no-prepared-sequence'
  | 'stale'
  | 'ready';

export type CleanupReviewReport = Readonly<{
  enabled: boolean;
  status: CleanupReviewReportStatus;
  message: string;
  preparedSequenceAvailable: boolean;
  stateCurrent: boolean;
  items: readonly CleanupReviewItem[];
}>;

export type CleanupReviewMutation =
  | Readonly<{
    ok: true;
    project: CleanupReviewProject;
    decision: T1CleanupReviewDecision;
    removal?: Readonly<{ t0: number; t1: number }>;
  }>
  | Readonly<{
    ok: false;
    project: CleanupReviewProject;
    error: string;
  }>;

export type CleanupReviewConfirmation = Readonly<{
  recordingId: string;
  fingerprint: string;
}>;

type CleanupSnapshot = NonNullable<NonNullable<Project['speechControl']>['cleanup']>[number];
type CaptureRecording = NonNullable<NonNullable<Project['speechControl']>['capture']['recordings']>[number];
type SuggestionEntry = Readonly<{
  snapshot: CleanupSnapshot;
  suggestion: CleanupSuggestion;
}>;

const EPSILON = 1e-9;

function copySegment(segment: CleanupReviewSegment): CleanupReviewSegment {
  return {
    ...segment,
    ...(segment.crop ? { crop: { ...segment.crop } } : {}),
    ...(segment.captions ? { captions: segment.captions.map(caption => ({ ...caption })) } : {}),
  };
}

function copySegments(segments: readonly CleanupReviewSegment[]): CleanupReviewSegment[] {
  return segments.map(copySegment);
}

function speechEnvelope(project: CleanupReviewProject): NonNullable<Project['speechControl']> | undefined {
  return project.speechControl;
}

function isCurrentSpeechEnvelope(project: CleanupReviewProject): boolean {
  const envelope = speechEnvelope(project);
  if (!envelope
    || envelope.version !== 1
    || envelope.projectId !== project.id
    || typeof envelope.revision !== 'string'
    || envelope.revision.length === 0
    || envelope.status !== 'available'
    || !Array.isArray(envelope.scriptSnapshot)
    || !envelope.capture || typeof envelope.capture !== 'object'
    || !envelope.mustSay || typeof envelope.mustSay !== 'object'
    || !Array.isArray(envelope.cleanup)) return false;
  const currentScript = projectScriptLines(project)
    .filter(line => line.spokenText.trim())
    .map(line => ({ lineId: line.id, spokenText: line.spokenText }));
  return envelope.scriptSnapshot.length === currentScript.length
    && envelope.scriptSnapshot.every((line, index) => line?.lineId === currentScript[index].lineId
      && line.spokenText === currentScript[index].spokenText);
}

function snapshots(project: CleanupReviewProject): readonly CleanupSnapshot[] {
  const envelope = speechEnvelope(project);
  return envelope && Array.isArray(envelope.cleanup) ? envelope.cleanup : [];
}

function suggestionEntries(project: CleanupReviewProject): SuggestionEntry[] {
  const result: SuggestionEntry[] = [];
  for (const snapshot of snapshots(project)) {
    if (!snapshot || typeof snapshot.recordingId !== 'string' || !snapshot.plan
      || !Array.isArray(snapshot.plan.suggestions)) continue;
    for (const suggestion of snapshot.plan.suggestions) {
      if (!suggestion || typeof suggestion.id !== 'string') continue;
      result.push({ snapshot, suggestion });
    }
  }
  return result;
}

function findEntry(
  project: CleanupReviewProject,
  suggestionId: string,
  recordingId?: string,
): SuggestionEntry | undefined {
  return suggestionEntries(project).find(entry => entry.suggestion.id === suggestionId
    && (recordingId === undefined
      || entry.snapshot.recordingId === recordingId
      || entry.suggestion.recordingId === recordingId));
}

function captureRecordings(project: CleanupReviewProject): readonly CaptureRecording[] {
  const capture = speechEnvelope(project)?.capture;
  return capture && Array.isArray(capture.recordings) ? capture.recordings : [];
}

function recordingFor(project: CleanupReviewProject, recordingId: string): CaptureRecording | undefined {
  return captureRecordings(project).find(recording => recording?.recordingId === recordingId);
}

function hasCurrentMedia(project: CleanupReviewProject, recordingId: string): boolean {
  const recording = recordingFor(project, recordingId);
  if (recording?.mediaAvailable !== true
    || typeof recording.mediaUri !== 'string'
    || recording.mediaUri.length === 0) return false;
  if (Array.isArray(project.availableMediaUris)) return project.availableMediaUris.includes(recording.mediaUri);
  // Legacy projects may not have a refreshed inventory.  The primary source
  // can use the legacy mediaMissing flag; pickup sources remain unavailable
  // until the store supplies an explicit inventory entry.
  return recording.mediaUri === project.videoUri && project.mediaMissing === false;
}

function currentMediaUri(project: CleanupReviewProject, recordingId: string): string | undefined {
  const recording = recordingFor(project, recordingId);
  return typeof recording?.mediaUri === 'string' && recording.mediaUri.length > 0
    ? recording.mediaUri
    : undefined;
}

function preparedSegments(project: CleanupReviewProject): readonly CleanupReviewSegment[] {
  const state = project.cleanupReview;
  if (state && state.projectId === project.id && state.speechRevision === project.speechControl?.revision) {
    return state.baseReviewSegments;
  }
  return Array.isArray(project.reviewSegments) ? project.reviewSegments : [];
}

function intervalContained(
  segment: CleanupReviewSegment,
  uri: string,
  interval: Readonly<{ t0: number; t1: number }>,
): boolean {
  return segment.uri === uri
    && interval.t0 >= segment.t0 - EPSILON
    && interval.t1 <= segment.t1 + EPSILON
    && interval.t1 > interval.t0;
}

function hasPreparedInterval(
  segments: readonly CleanupReviewSegment[],
  uri: string | undefined,
  interval: Readonly<{ t0: number; t1: number }> | null,
): boolean {
  return !!uri && !!interval
    && segments.filter(segment => intervalContained(segment, uri, interval)).length === 1;
}

function reviewSegmentsFingerprint(segments: readonly CleanupReviewSegment[]): string {
  return JSON.stringify(segments);
}

function hasVerifiedRemovalProof(suggestion: CleanupSuggestion): boolean {
  const verifiedBoundary = (boundary: CleanupSuggestion['startBoundary'] | undefined) => !!boundary
    && boundary.verified === true
    && (boundary.source === 'independent-silence' || boundary.source === 'manual-review');
  return canPrepareCleanupRemoval(suggestion)
    && suggestion.safeToRemove === true
    && suggestion.safeBoundary === 'safe'
    && verifiedBoundary(suggestion.startBoundary)
    && verifiedBoundary(suggestion.endBoundary)
    && suggestion.recordingId !== undefined
    && suggestion.removalInterval !== null
    && Number.isFinite(suggestion.removalInterval.t0)
    && Number.isFinite(suggestion.removalInterval.t1)
    && suggestion.removalInterval.t1 > suggestion.removalInterval.t0;
}

function stateIsCurrent(project: CleanupReviewProject): boolean {
  const state = project.cleanupReview;
  return state === undefined
    || (state.version === T1_CLEANUP_REVIEW_VERSION
      && state.projectId === project.id
      && state.speechRevision === project.speechControl?.revision
      && Array.isArray(state.baseReviewSegments)
      && typeof state.appliedReviewSegmentsFingerprint === 'string'
      && Array.isArray(state.decisions)
      && reviewSegmentsFingerprint(project.reviewSegments ?? []) === state.appliedReviewSegmentsFingerprint);
}

function stateDecision(
  state: T1CleanupReviewState | undefined,
  suggestion: CleanupSuggestion,
  recordingId: string,
): T1CleanupReviewDecision | undefined {
  return state?.decisions.find(decision => decision.suggestionId === suggestion.id
    && decision.recordingId === recordingId);
}

function producerDecision(
  snapshot: CleanupSnapshot,
  suggestion: CleanupSuggestion,
): ProducerCleanupDecision | undefined {
  return Array.isArray(snapshot.plan.decisions)
    ? snapshot.plan.decisions.find(decision => decision.suggestionId === suggestion.id)
    : undefined;
}

function statusForItem(
  suggestion: CleanupSuggestion,
  decision: ProducerCleanupDecision | undefined,
  storedDecision: T1CleanupReviewDecision | undefined,
  recordingId: string,
  currentMedia: boolean,
  hasSequence: boolean,
  intervalPrepared: boolean,
  stateCurrent: boolean,
  planCurrent: boolean,
): { status: CleanupReviewItemStatus; unavailableReason?: string } {
  const active = storedDecision ?? decision;
  if (!stateCurrent) return { status: 'stale', unavailableReason: 'This cleanup review belongs to an older speech evidence revision.' };
  if (active && (active.recordingId !== recordingId || active.fingerprint !== suggestion.fingerprint)) {
    return { status: 'stale', unavailableReason: 'The stored cleanup choice no longer matches this recording or evidence fingerprint.' };
  }
  if (active?.action === 'accept'
    && active.fingerprint === suggestion.fingerprint
    && active.recordingId === recordingId) return { status: 'accepted' };
  if (active?.action === 'dismiss'
    && active.fingerprint === suggestion.fingerprint
    && active.recordingId === recordingId) return { status: 'dismissed' };
  if (!hasSequence) return { status: 'unavailable', unavailableReason: 'Prepare takes first.' };
  if (!planCurrent) return { status: 'unavailable', unavailableReason: 'Cleanup decision evidence is malformed or unavailable. Keep this as a review mark.' };
  if (!currentMedia) return { status: 'unavailable', unavailableReason: 'Supporting media is missing from the current media inventory.' };
  if (!hasVerifiedRemovalProof(suggestion)) {
    return { status: 'review-only', unavailableReason: 'Safe removal boundaries are unavailable. Keep this as a review mark.' };
  }
  if (!intervalPrepared) return { status: 'stale', unavailableReason: 'The removal interval is outside the prepared review sequence.' };
  return { status: 'pending' };
}

/** Build the review rows without changing the producer envelope or project. */
export function buildCleanupReview(
  project: CleanupReviewProject,
  enabled = false,
): CleanupReviewReport {
  if (!enabled) return {
    enabled: false,
    status: 'disabled',
    message: 'Cleanup review is off.',
    preparedSequenceAvailable: false,
    stateCurrent: true,
    items: [],
  };

  if (!isCurrentSpeechEnvelope(project)) return {
    enabled: true,
    status: 'unavailable',
    message: 'Cleanup evidence is unavailable or stale for this project.',
    preparedSequenceAvailable: false,
    stateCurrent: true,
    items: [],
  };

  const stateCurrent = stateIsCurrent(project);
  const segments = preparedSegments(project);
  const preparedSequenceAvailable = segments.length > 0;
  const items = suggestionEntries(project).map(({ snapshot, suggestion }) => {
    const recordingId = snapshot.recordingId;
    const uri = currentMediaUri(project, recordingId);
    const currentMedia = hasCurrentMedia(project, recordingId);
    const decision = producerDecision(snapshot, suggestion);
    const planCurrent = Array.isArray(snapshot.plan.decisions);
    const stored = stateCurrent ? stateDecision(project.cleanupReview, suggestion, recordingId) : undefined;
    const intervalPrepared = hasPreparedInterval(segments, uri, suggestion.removalInterval);
    const itemState = statusForItem(
      suggestion,
      decision,
      stored,
      recordingId,
      currentMedia,
      preparedSequenceAvailable,
      intervalPrepared,
      stateCurrent,
      planCurrent,
    );
    const canAccept = stateCurrent
      && planCurrent
      && itemState.status === 'pending'
      && hasVerifiedRemovalProof(suggestion);
    const previewFootage = currentMedia && uri
      ? { recordingId, uri, t0: suggestion.t0, t1: suggestion.t1 }
      : undefined;
    return {
      id: suggestion.id,
      recordingId,
      suggestion,
      reason: suggestion.reason,
      evidence: suggestion.evidence,
      decision: stored ?? decision,
      status: itemState.status,
      ...(previewFootage ? { previewFootage } : {}),
      canPreview: !!previewFootage,
      canAccept,
      ...(itemState.unavailableReason ? { unavailableReason: itemState.unavailableReason } : {}),
    };
  });

  return {
    enabled: true,
    status: !stateCurrent
      ? 'stale'
      : !preparedSequenceAvailable
        ? 'no-prepared-sequence'
        : 'ready',
    message: !stateCurrent
      ? 'Cleanup evidence is stale. Reset the review before applying a new decision.'
      : !preparedSequenceAvailable
        ? 'Prepare takes first to review cleanup against the saved sequence.'
        : 'Review each producer suggestion before applying a reversible cleanup.',
    preparedSequenceAvailable,
    stateCurrent,
    items,
  };
}

function identitiesFor(project: CleanupReviewProject): T1CleanupReviewIdentity[] {
  return snapshots(project).map(snapshot => ({
    recordingId: snapshot.recordingId,
    mediaUri: currentMediaUri(project, snapshot.recordingId) ?? null,
  }));
}

function copyStateSegments(project: CleanupReviewProject): CleanupReviewSegment[] {
  if (stateIsCurrent(project) && project.cleanupReview) {
    return copySegments(project.cleanupReview.baseReviewSegments);
  }
  return copySegments(Array.isArray(project.reviewSegments) ? project.reviewSegments : []);
}

function replaceInterval(
  segments: readonly CleanupReviewSegment[],
  uri: string,
  interval: Readonly<{ t0: number; t1: number }>,
): { ok: true; segments: CleanupReviewSegment[] } | { ok: false; error: string } {
  const matches = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => intervalContained(segment, uri, interval));
  if (matches.length !== 1) {
    return { ok: false, error: 'The cleanup interval does not match exactly one prepared review segment.' };
  }
  const match = matches[0];
  const replacement: CleanupReviewSegment[] = [];
  if (match.segment.t0 < interval.t0 - EPSILON) {
    replacement.push(copySegment({ ...match.segment, t1: interval.t0 }));
  }
  if (match.segment.t1 > interval.t1 + EPSILON) {
    replacement.push(copySegment({ ...match.segment, t0: interval.t1 }));
  }
  return {
    ok: true,
    segments: [
      ...segments.slice(0, match.index).map(copySegment),
      ...replacement,
      ...segments.slice(match.index + 1).map(copySegment),
    ],
  };
}

function deriveAcceptedSegments(
  project: CleanupReviewProject,
  baseSegments: readonly CleanupReviewSegment[],
  decisions: readonly T1CleanupReviewDecision[],
): { ok: true; segments: CleanupReviewSegment[]; lastRemoval?: { t0: number; t1: number } } | { ok: false; error: string } {
  let segments = copySegments(baseSegments);
  let lastRemoval: { t0: number; t1: number } | undefined;
  for (const decision of decisions.filter(item => item.action === 'accept')) {
    const entry = findEntry(project, decision.suggestionId, decision.recordingId);
    if (!entry || entry.suggestion.recordingId !== decision.recordingId
      || entry.suggestion.fingerprint !== decision.fingerprint) {
      return { ok: false, error: 'A saved cleanup decision is stale for the current producer evidence.' };
    }
    if (!Array.isArray(entry.snapshot.plan.decisions) || !hasVerifiedRemovalProof(entry.suggestion)) {
      return { ok: false, error: 'A saved cleanup decision has no verified removal proof.' };
    }
    const prepared = prepareCleanupRemoval(entry.suggestion, [{
      id: decision.id,
      suggestionId: decision.suggestionId,
      action: 'accept',
      recordingId: decision.recordingId,
      fingerprint: decision.fingerprint,
    }]);
    const uri = currentMediaUri(project, decision.recordingId);
    if (!prepared || !uri) return { ok: false, error: 'A saved cleanup decision has no current media provenance.' };
    const next = replaceInterval(segments, uri, prepared);
    if (!next.ok) return next;
    segments = next.segments;
    lastRemoval = prepared;
  }
  return { ok: true, segments, ...(lastRemoval ? { lastRemoval } : {}) };
}

function mutationFailure(project: CleanupReviewProject, error: string): CleanupReviewMutation {
  return { ok: false, project, error };
}

/** Apply one explicit producer decision and derive only the existing prepared sequence. */
export function applyCleanupReviewDecision(
  project: CleanupReviewProject,
  suggestionId: string,
  action: 'accept' | 'dismiss',
  confirmation?: CleanupReviewConfirmation,
): CleanupReviewMutation {
  if (!isCurrentSpeechEnvelope(project)) return mutationFailure(project, 'Cleanup evidence is unavailable or stale.');
  if (!stateIsCurrent(project)) return mutationFailure(project, 'Cleanup review state is stale. Reset it before applying a new decision.');

  const unscopedEntry = findEntry(project, suggestionId);
  const entry = findEntry(project, suggestionId, confirmation?.recordingId);
  if (!entry) {
    if (confirmation && unscopedEntry && confirmation.recordingId !== unscopedEntry.snapshot.recordingId) {
      return mutationFailure(project, 'Cleanup recording identity does not match the current suggestion.');
    }
    return mutationFailure(project, 'Cleanup suggestion is unavailable or stale.');
  }
  const recordingId = entry.snapshot.recordingId;
  const suggestion = entry.suggestion;
  if (suggestion.recordingId !== recordingId) return mutationFailure(project, 'Cleanup suggestion recording identity is stale.');
  if (!Array.isArray(entry.snapshot.plan.decisions)) {
    return mutationFailure(project, 'Cleanup decision evidence is malformed or unavailable.');
  }

  if (action === 'accept') {
    if (!confirmation || confirmation.recordingId !== recordingId) {
      return mutationFailure(project, 'An explicit matching recording confirmation is required.');
    }
    if (confirmation.fingerprint !== suggestion.fingerprint) {
      return mutationFailure(project, 'Cleanup evidence fingerprint is stale. Review the current suggestion again.');
    }
    if (!hasVerifiedRemovalProof(suggestion)) {
      return mutationFailure(project, 'This cleanup suggestion has no safe removal interval. Keep it as a review mark.');
    }
    if (!hasCurrentMedia(project, recordingId)) {
      return mutationFailure(project, 'Current media inventory does not contain the cleanup recording.');
    }
  }

  const producerDecisions = applyCleanupDecision(entry.snapshot.plan.decisions, suggestion, action);
  const producerDecisionForSuggestion = producerDecisions.find(decision => decision.suggestionId === suggestion.id);
  if (!producerDecisionForSuggestion || typeof producerDecisionForSuggestion.fingerprint !== 'string') {
    return mutationFailure(project, 'The producer cleanup decision could not be prepared.');
  }
  if (action === 'accept' && prepareCleanupRemoval(suggestion, [producerDecisionForSuggestion]) === null) {
    return mutationFailure(project, 'The producer did not confirm a safe reversible removal.');
  }

  const baseSegments = copyStateSegments(project);
  if (baseSegments.length === 0) return mutationFailure(project, 'Prepare takes first.');
  const existingDecisions = stateIsCurrent(project) && project.cleanupReview
    ? project.cleanupReview.decisions.filter(decision => !(decision.suggestionId === suggestion.id && decision.recordingId === recordingId))
    : [];
  const nextDecision: T1CleanupReviewDecision = {
    id: producerDecisionForSuggestion.id,
    suggestionId: suggestion.id,
    recordingId,
    action,
    fingerprint: producerDecisionForSuggestion.fingerprint,
  };
  const decisions = [...existingDecisions, nextDecision];
  const derived = deriveAcceptedSegments(project, baseSegments, decisions);
  if (!derived.ok) return mutationFailure(project, derived.error);

  const envelope = project.speechControl;
  if (!envelope) return mutationFailure(project, 'Cleanup evidence is unavailable.');
  const state: T1CleanupReviewState = {
    version: T1_CLEANUP_REVIEW_VERSION,
    projectId: project.id,
    speechRevision: envelope.revision,
    baseReviewSegments: copySegments(baseSegments),
    appliedReviewSegmentsFingerprint: reviewSegmentsFingerprint(derived.segments),
    identities: identitiesFor(project),
    decisions,
  };
  const nextProject: CleanupReviewProject = {
    ...project,
    reviewSegments: derived.segments,
    cutsReviewed: false,
    cleanupReview: state,
  };
  return {
    ok: true,
    project: nextProject,
    decision: nextDecision,
    ...(derived.lastRemoval ? { removal: derived.lastRemoval } : {}),
  };
}

/** Turn cleanup off and restore the exact prepared sequence captured at first accept/dismiss. */
export function resetCleanupReview(project: CleanupReviewProject): CleanupReviewProject {
  const state = project.cleanupReview;
  if (!state) return project;
  // A separate review edit may have changed the sequence since this state was
  // applied.  Preserve that edit and the cleanup state rather than clobbering
  // it with the older base sequence.
  if (!stateIsCurrent(project)) return project;
  return {
    ...project,
    reviewSegments: copySegments(state.baseReviewSegments),
    cutsReviewed: false,
    cleanupReview: undefined,
  };
}
