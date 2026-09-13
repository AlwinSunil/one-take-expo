import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCleanupReviewDecision,
  buildCleanupReview,
  resetCleanupReview,
} from '../src/lib/t1-cleanup-review.ts';
import { generateCleanupSuggestions, createCleanupPlan } from '../src/features/speech-control/cleanup.ts';

function project({ availableMediaUris = ['file:///take-a.mp4'], reviewSegments, speechRevision = 'speech-1' } = {}) {
  const [suggestion] = generateCleanupSuggestions({
    recordingId: 'recording-a',
    segments: [],
    fillerMarks: [{
      id: 'filler-1',
      recordingId: 'recording-a',
      kind: 'filler',
      text: 'um',
      t0: 2,
      t1: 2.25,
      isMidSentence: false,
      startBoundary: { source: 'independent-silence', verified: true },
      endBoundary: { source: 'independent-silence', verified: true },
    }],
  });
  const plan = createCleanupPlan({ recordingId: 'recording-a', segments: [], fillerMarks: [{
    id: 'filler-1', recordingId: 'recording-a', kind: 'filler', text: 'um', t0: 2, t1: 2.25,
    isMidSentence: false,
    startBoundary: { source: 'independent-silence', verified: true },
    endBoundary: { source: 'independent-silence', verified: true },
  }] });
  assert.equal(plan.suggestions[0].id, suggestion.id);
  return {
    id: 'project-a',
    mode: 'assisted',
    createdAt: 0,
    clips: [],
    script: '',
    transcript: [{ id: 'raw-1', t0: 0, t1: 5, text: 'Hello um world' }],
    rawTranscript: [{ id: 'raw-1', t0: 0, t1: 5, text: 'Hello um world' }],
    videoUri: 'file:///original.mp4',
    reviewSegments: reviewSegments ?? [{ uri: 'file:///take-a.mp4', t0: 0, t1: 5, takeId: 'take-a' }],
    availableMediaUris,
    mediaMissing: false,
    speechControl: {
      version: 1,
      projectId: 'project-a',
      provider: 'fixture',
      revision: speechRevision,
      status: 'available',
      scriptSnapshot: [],
      capture: {
        recordings: [{ recordingId: 'recording-a', mediaUri: 'file:///take-a.mp4', duration: 5, mediaAvailable: true }],
        takeDecisions: [],
      },
      mustSay: { metadata: [], segments: [], mediaAvailable: true },
      cleanup: [{ recordingId: 'recording-a', plan }],
    },
  };
}

function suggestionOf(value) {
  return value.speechControl.cleanup[0].plan.suggestions[0];
}

test('cleanup review displays producer reason/evidence and accepts only a prepared safe removal', () => {
  const original = project();
  const report = buildCleanupReview(original, true);
  const item = report.items[0];

  assert.equal(report.status, 'ready');
  assert.match(item.reason, /verified quiet boundaries/i);
  assert.equal(item.evidence[0].type, 'speech-mark');
  assert.equal(item.canPreview, true);
  assert.equal(item.canAccept, true);

  const suggestion = suggestionOf(original);
  const result = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.project.reviewSegments, [
    { uri: 'file:///take-a.mp4', t0: 0, t1: 2, takeId: 'take-a' },
    { uri: 'file:///take-a.mp4', t0: 2.25, t1: 5, takeId: 'take-a' },
  ]);
  assert.deepEqual(result.project.cleanupReview?.baseReviewSegments, original.reviewSegments);
  assert.equal(result.project.cleanupReview?.decisions[0].action, 'accept');
  assert.equal(result.project.videoUri, original.videoUri);
  assert.deepEqual(result.project.transcript, original.transcript);
  assert.deepEqual(result.project.rawTranscript, original.rawTranscript);
});

test('reset restores the original prepared sequence while retaining original media and evidence', () => {
  const original = project();
  const suggestion = suggestionOf(original);
  const accepted = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(accepted.ok, true);

  const reset = resetCleanupReview(accepted.project);
  assert.deepEqual(reset.reviewSegments, original.reviewSegments);
  assert.equal(reset.cleanupReview, undefined);
  assert.equal(reset.videoUri, original.videoUri);
  assert.deepEqual(reset.transcript, original.transcript);
  assert.deepEqual(reset.rawTranscript, original.rawTranscript);
});

test('explicit keep or undo dismisses a prepared removal and restores the base sequence', () => {
  const original = project();
  const suggestion = suggestionOf(original);
  const accepted = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(accepted.ok, true);

  const dismissed = applyCleanupReviewDecision(accepted.project, suggestion.id, 'dismiss');
  assert.equal(dismissed.ok, true);
  assert.deepEqual(dismissed.project.reviewSegments, original.reviewSegments);
  assert.equal(dismissed.project.cleanupReview?.decisions[0].action, 'dismiss');
});

test('missing current media inventory leaves the evidence reviewable but cannot accept removal', () => {
  const missing = project({ availableMediaUris: [] });
  const report = buildCleanupReview(missing, true);
  const item = report.items[0];
  assert.equal(item.canPreview, false);
  assert.equal(item.canAccept, false);
  assert.match(item.unavailableReason, /media/i);

  const suggestion = suggestionOf(missing);
  const result = applyCleanupReviewDecision(missing, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /media inventory/i);
  assert.deepEqual(result.project.reviewSegments, missing.reviewSegments);
});

test('stale fingerprint and foreign recording cannot accept a cleanup removal', () => {
  const original = project();
  const suggestion = suggestionOf(original);
  const stale = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: 'stale-fingerprint',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /fingerprint/i);
  assert.deepEqual(stale.project.reviewSegments, original.reviewSegments);

  const foreign = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: 'recording-other',
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /recording/i);
});

test('recognition-only or mid-sentence marks stay review marks and never create a guessed splice', () => {
  const markPlan = createCleanupPlan({
    recordingId: 'recording-a',
    segments: [],
    marks: [{
      id: 'filler-mid', recordingId: 'recording-a', kind: 'filler', text: 'um', t0: 2, t1: 2.25,
      isMidSentence: true,
      safeBoundary: true,
    }],
  });
  const value = project();
  value.speechControl.cleanup[0].plan = markPlan;
  const suggestion = suggestionOf(value);
  assert.equal(suggestion.canPrepareRemoval, false);
  const report = buildCleanupReview(value, true);
  assert.equal(report.items[0].canAccept, false);
  const result = applyCleanupReviewDecision(value, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /safe removal/i);
  assert.deepEqual(result.project.reviewSegments, value.reviewSegments);
});

test('without an explicit prepared review sequence the report asks the user to prepare takes first', () => {
  const value = project({ reviewSegments: undefined });
  delete value.reviewSegments;
  const report = buildCleanupReview(value, true);
  assert.equal(report.status, 'no-prepared-sequence');
  assert.match(report.message, /prepare takes first/i);
  assert.equal(report.items[0].canAccept, false);
});

test('pickup media remains reviewable when the missing primary source is unavailable', () => {
  const value = project({ availableMediaUris: ['file:///take-a.mp4'] });
  value.videoUri = 'file:///missing-original.mp4';
  value.mediaMissing = true;
  const report = buildCleanupReview(value, true);
  assert.equal(report.items[0].canPreview, true);
  assert.equal(report.items[0].canAccept, true);
});

test('malformed producer decisions fail closed without crashing the review', () => {
  const value = project();
  value.speechControl.cleanup[0].plan.decisions = null;
  const report = buildCleanupReview(value, true);
  assert.equal(report.items[0].status, 'unavailable');
  assert.equal(report.items[0].canAccept, false);
  assert.match(report.items[0].unavailableReason, /malformed/i);
  const suggestion = suggestionOf(value);
  const result = applyCleanupReviewDecision(value, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /malformed/i);
});

test('persisted recognition-only proof cannot be promoted by a malformed safe flag', () => {
  const value = project();
  const suggestion = suggestionOf(value);
  value.speechControl.cleanup[0].plan.suggestions[0] = {
    ...suggestion,
    canPrepareRemoval: true,
    safeToRemove: true,
    safeBoundary: 'safe',
    startBoundary: null,
    endBoundary: null,
  };
  const current = suggestionOf(value);
  const report = buildCleanupReview(value, true);
  assert.equal(report.items[0].canAccept, false);
  const result = applyCleanupReviewDecision(value, current.id, 'accept', {
    recordingId: current.recordingId,
    fingerprint: current.fingerprint,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /safe removal/i);
});

test('reset preserves an independently changed prepared sequence', () => {
  const original = project();
  const suggestion = suggestionOf(original);
  const accepted = applyCleanupReviewDecision(original, suggestion.id, 'accept', {
    recordingId: suggestion.recordingId,
    fingerprint: suggestion.fingerprint,
  });
  assert.equal(accepted.ok, true);
  const independentlyChanged = {
    ...accepted.project,
    reviewSegments: [...accepted.project.reviewSegments, { uri: 'file:///take-a.mp4', t0: 5, t1: 5.5, takeId: 'take-a' }],
  };
  const reset = resetCleanupReview(independentlyChanged);
  assert.equal(reset, independentlyChanged);
  assert.ok(reset.cleanupReview);
  assert.deepEqual(reset.reviewSegments, independentlyChanged.reviewSegments);
});
