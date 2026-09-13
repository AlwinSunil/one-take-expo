import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACOUSTIC_FILLER_SCHEMA_VERSION,
  adaptAcousticFillerResult,
  acousticFillerResultToCleanupMarks,
  validateAcousticFillerResult,
} from '../src/features/speech-control/acoustic-fillers.ts';
import { createCleanupPlan } from '../src/features/speech-control/cleanup.ts';

const scope = { sourceId: 'recording-a', analysisRevision: 3 };

function result(overrides = {}) {
  return {
    schemaVersion: ACOUSTIC_FILLER_SCHEMA_VERSION,
    status: 'ready',
    sourceId: scope.sourceId,
    analysisRevision: scope.analysisRevision,
    model: { id: 'filler-baseline', version: '2026-09-13' },
    actualProcessor: 'cpu',
    durationSeconds: 12,
    events: [{
      id: 'event-um-1',
      startSeconds: 2.25,
      endSeconds: 2.62,
      label: 'um',
      score: 0.83,
      timingUncertaintySeconds: 0.14,
    }],
    ...overrides,
  };
}

test('valid acoustic events map to source-scoped review-only cleanup marks', () => {
  const validated = validateAcousticFillerResult(result(), scope);
  const marks = acousticFillerResultToCleanupMarks(validated, scope);

  assert.deepEqual(marks, [{
    id: 'event-um-1',
    recordingId: 'recording-a',
    kind: 'filler',
    text: 'um',
    t0: 2.25,
    t1: 2.62,
    safeBoundary: false,
    boundarySource: 'unknown',
    startBoundary: { source: 'unknown', verified: false },
    endBoundary: { source: 'unknown', verified: false },
  }]);
  assert.equal('confidence' in marks[0], false);
  assert.equal(marks[0].isMidSentence, undefined);
});

test('acoustic detections create a cleanup mark and never a removal candidate', () => {
  const marks = acousticFillerResultToCleanupMarks(result(), scope);
  const plan = createCleanupPlan({
    recordingId: scope.sourceId,
    segments: [],
    fillerMarks: marks,
  });

  assert.equal(plan.suggestions.length, 1);
  assert.equal(plan.suggestions[0].kind, 'filler');
  assert.equal(plan.suggestions[0].action, 'mark');
  assert.equal(plan.suggestions[0].removalInterval, null);
  assert.equal(plan.suggestions[0].removal, null);
  assert.equal(plan.suggestions[0].safeToRemove, false);
  assert.equal(plan.suggestions[0].canPrepareRemoval, false);
});

test('model unavailable is distinct from a ready result with zero detections', () => {
  const unavailable = adaptAcousticFillerResult(result({
    status: 'unavailable',
    events: [],
    unavailableReason: 'The acoustic model is not installed on this device.',
  }), scope);
  const empty = adaptAcousticFillerResult(result({ events: [] }), scope);

  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.marks, []);
  assert.match(unavailable.reason, /model/i);
  assert.equal(empty.status, 'ready');
  assert.deepEqual(empty.marks, []);
});

test('unmeasured model timing remains unknown while source-frame resolution is retained', () => {
  const validated = validateAcousticFillerResult(result({
    events: [{
      ...result().events[0],
      timingUncertaintySeconds: null,
      timingResolutionSeconds: 0.01,
    }],
    provenance: {
      source: 'host-audio',
      audioSha256: 'a'.repeat(64),
      modelSha256: 'b'.repeat(64),
      timingSource: 'decoded-pcm-samples',
      scoreMeaning: 'uncalibrated-model-score',
      boundaryStatus: 'unverified',
      releaseValidated: false,
    },
  }), scope);

  assert.equal(validated.events[0].timingUncertaintySeconds, null);
  assert.equal(validated.events[0].timingResolutionSeconds, 0.01);
  assert.equal(validated.provenance.source, 'host-audio');
  assert.equal(validated.provenance.boundaryStatus, 'unverified');
});

test('a short source may have frame resolution larger than its source duration', () => {
  const short = result({
    durationSeconds: 0.005,
    events: [{
      ...result().events[0],
      startSeconds: 0.001,
      endSeconds: 0.004,
      timingUncertaintySeconds: null,
      timingResolutionSeconds: 0.02,
    }],
  });
  const marks = acousticFillerResultToCleanupMarks(short, scope);
  assert.equal(marks[0].t0, 0.001);
  assert.equal(marks[0].t1, 0.004);
});

test('stale source and analysis revisions are rejected before marks are created', () => {
  assert.throws(
    () => adaptAcousticFillerResult(result({ sourceId: 'recording-other' }), scope),
    /source identity|sourceId|stale/i,
  );
  assert.throws(
    () => adaptAcousticFillerResult(result({ analysisRevision: 2 }), scope),
    /analysis revision|analysisRevision|stale/i,
  );
});

test('malformed acoustic results fail closed for duplicate ids, non-finite values, and bad ranges', () => {
  assert.throws(
    () => validateAcousticFillerResult(result({
      events: [
        result().events[0],
        { ...result().events[0], startSeconds: 4, endSeconds: 4.4 },
      ],
    }), scope),
    /duplicate.*event/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      events: [{ ...result().events[0], startSeconds: Number.NaN }],
    }), scope),
    /finite|startSeconds/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      events: [{ ...result().events[0], startSeconds: 11.8, endSeconds: 12.1 }],
    }), scope),
    /duration|endSeconds|range/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      events: [{ ...result().events[0], label: 'like' }],
    }), scope),
    /label/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      analysisRevision: Number.MAX_SAFE_INTEGER + 1,
    }), scope),
    /analysisRevision/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      provenance: { audioSha256: 'not-a-hash' },
    }), scope),
    /sha-256|audioSha256/i,
  );
  assert.throws(
    () => validateAcousticFillerResult(result({
      events: [{ ...result().events[0], score: 1.01 }],
    }), scope),
    /score/i,
  );
});
