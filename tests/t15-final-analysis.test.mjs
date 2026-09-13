import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeFinalTake,
  createFinalAnalysis,
  validateFinalAnalysisScope,
  FinalAnalysisStaleError,
} from '../src/features/speech-analysis/final-analysis.ts';

const scope = {
  projectId: 'project-1',
  sourceId: 'source-1',
  scriptRevision: 'script-1',
  editRevision: 'edit-1',
  transcriptRevision: 'transcript-1',
};

const span = (text, order = 0, lineId = `line-${order}`) => ({
  id: `${lineId}:spoken`,
  lineId,
  scriptRevision: scope.scriptRevision,
  start: 0,
  end: text.length,
  text,
  order,
});

const observation = (id, text, t0, t1, extra = {}) => ({
  id,
  sourceId: scope.sourceId,
  takeId: extra.takeId ?? `take-${id}`,
  t0,
  t1,
  text,
  isFinal: true,
  provenance: 'recognition',
  uncertaintySeconds: null,
  verifiedBoundary: false,
  ...extra,
});

test('no speech is unavailable, preserves the source range, and has no recommendation', () => {
  const result = createFinalAnalysis({ scope, jobId: 'job-empty', sourceDuration: 5, observations: [] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.recommendedAttemptId, null);
  assert.equal(result.rangeProposal.state, 'unavailable');
  assert.deepEqual(result.rangeProposal.ranges.map(range => [range.t0, range.t1, range.disposition]), [[0, 5, 'retained']]);
  assert.match(result.reasons.find(reason => reason.code === 'no-speech').message, /original source remains available/i);
});

test('partial-to-final revisions remain in the complete transcript history but classify from the final snapshot', () => {
  const text = 'Today I am going to show you how One Take works.';
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-revision',
    sourceDuration: 5,
    scriptSpans: [span(text)],
    observations: [
      observation('u:partial', 'Today I am going to show you', 0, 1, {
        takeId: 'take-1', utteranceId: 'utterance-1', revision: 1, isFinal: false,
      }),
      observation('u:final', text, 0, 2, {
        takeId: 'take-1', utteranceId: 'utterance-1', revisionOf: 'u:partial', revision: 2,
      }),
    ],
  });
  assert.equal(result.transcriptHistory.length, 2);
  assert.deepEqual(result.attempts[0].observationIds, ['u:partial', 'u:final']);
  assert.equal(result.attempts[0].kind, 'complete');
  assert.equal(result.attempts[0].isComplete, true);
  assert.equal(result.recommendedAttemptId, result.attempts[0].id);
});

test('a later final revision with changed facts cannot be rescued by an earlier matching snapshot', () => {
  const expected = 'Alice has 3 cameras.';
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-late-change',
    sourceDuration: 4,
    scriptSpans: [span(expected)],
    observations: [
      observation('old-final', expected, 0, 1, { takeId: 'take-1', utteranceId: 'utterance-1', revision: 1 }),
      observation('new-final', 'Alice has 4 cameras.', 0, 1.2, {
        takeId: 'take-1', utteranceId: 'utterance-1', revisionOf: 'old-final', revision: 2,
      }),
    ],
  });
  assert.deepEqual(result.transcriptHistory.map(item => item.id), ['old-final', 'new-final']);
  assert.equal(result.attempts[0].kind, 'mismatch');
  assert.equal(result.recommendedAttemptId, null);
});

test('a strong earlier complete take outranks a weak later repeat and only proposes safe whole-utterance exclusion', () => {
  const text = 'Today I am going to show you how One Take works.';
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-ranking',
    sourceDuration: 10,
    scriptSpans: [span(text)],
    observations: [
      observation('strong', text, 0, 2, { takeId: 'take-strong', provenance: 'manual-review', verifiedBoundary: true }),
      observation('weak', 'Today I am going to show you', 4, 5, { takeId: 'take-weak', provenance: 'manual-review', verifiedBoundary: true }),
    ],
  });
  const strong = result.attempts.find(attempt => attempt.observationIds.includes('strong'));
  const weak = result.attempts.find(attempt => attempt.observationIds.includes('weak'));
  assert.equal(result.recommendedAttemptId, strong.id);
  assert.equal(result.relatedAttemptGroups.some(group => group.attemptIds.includes(strong.id) && group.attemptIds.includes(weak.id)), true);
  const excluded = result.rangeProposal.ranges.find(range => range.observationIds.includes('weak'));
  assert.equal(excluded.disposition, 'excluded');
  assert.deepEqual([excluded.t0, excluded.t1], [4, 5]);
  assert.equal(excluded.observationIds.length, 1);
  assert.equal(result.rangeProposal.requiresCreatorAcceptance, true);
  assert.equal(result.rangeProposal.ranges.some(range => range.t0 === 2 && range.t1 === 4 && range.observationIds.length === 0), true);
});

test('changed numbers, names, and negation cannot become complete semantic matches', () => {
  const cases = [
    ['Alice has 3 cameras.', 'Alice has 4 cameras.'],
    ['Alice has 3 cameras.', 'Alicia has 3 cameras.'],
    ['The camera is not recording.', 'The camera is recording.'],
  ];
  for (const [expected, spoken] of cases) {
    const result = createFinalAnalysis({
      scope,
      jobId: `job-protected-${spoken}`,
      sourceDuration: 3,
      scriptSpans: [span(expected)],
      observations: [observation('changed', spoken, 0, 1)],
    });
    assert.equal(result.attempts[0].kind, 'mismatch');
    assert.equal(result.recommendedAttemptId, null);
  }
});

test('deliberate repeats stay retained and recognition-only boundaries never authorize exclusion', () => {
  const text = 'The result is ready.';
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-repeat',
    sourceDuration: 7,
    scriptSpans: [span(text)],
    observations: [
      observation('first', text, 0, 1, { takeId: 'take-1', intentionalRepeat: true }),
      observation('second', text, 3, 4, { takeId: 'take-2', confidence: 0.2, verifiedBoundary: true }),
    ],
  });
  assert.equal(result.rangeProposal.ranges.every(range => range.disposition === 'retained'), true);
  assert.equal(result.reasons.some(reason => reason.code === 'deliberate-repeat'), true);
  assert.equal(result.reasons.some(reason => reason.code === 'unsafe-boundary'), true);
});

test('missing source duration keeps analysis pending and withholds a partial range proposal', () => {
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-no-duration',
    scriptSpans: [span('A complete line.')],
    observations: [observation('one', 'A complete line.', 1, 2)],
  });
  assert.equal(result.state, 'pending');
  assert.equal(result.rangeProposal, null);
  assert.equal(result.reasons.some(reason => reason.code === 'pending-source-duration'), true);
});

test('gaze, delivery, and silence stay unknown when not collected', () => {
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-signals',
    sourceDuration: 3,
    observations: [observation('one', 'A complete line.', 0, 1)],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(result.signals).map(([key, value]) => [key, value.state])), {
    gaze: 'unknown', delivery: 'unknown', silence: 'unknown',
  });
  assert.equal(result.attempts[0].signalScore, null);
});

test('assisted mode treats restarts, ellipses, and trailing incomplete ideas as partial', () => {
  const result = createFinalAnalysis({
    scope,
    jobId: 'job-assisted',
    sourceDuration: 12,
    observations: [
      observation('restart', 'Welcome to One Take...', 0, 1),
      observation('unfinished-one', 'I want to.', 2, 3),
      observation('unfinished-two', 'Because we.', 4, 5),
      observation('complete', 'Welcome to One Take, the easiest way to record better videos.', 7, 9),
    ],
  });
  assert.deepEqual(result.attempts.map(attempt => attempt.kind), ['partial', 'partial', 'partial', 'complete']);
  assert.equal(result.recommendedAttemptId, result.attempts[3].id);
  assert.match(result.attempts[0].evidence.reasons.at(-1), /heuristic/i);
  assert.equal(result.relatedAttemptGroups.some(group => group.attemptIds.includes(result.attempts[0].id) && group.attemptIds.includes(result.attempts[3].id)), true);
});

test('cancel and stale checks stop the async producer between phases', async () => {
  let checks = 0;
  const cancelled = await analyzeFinalTake({
    scope,
    jobId: 'job-cancel',
    sourceDuration: 3,
    observations: [observation('one', 'A complete line.', 0, 1)],
  }, {
    yieldControl: async () => {},
    checkCancelled: () => ++checks > 1,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.rangeProposal, null);
  let current = scope;
  let yields = 0;
  const stale = await analyzeFinalTake({
    scope,
    jobId: 'job-stale',
    sourceDuration: 3,
    observations: [observation('one', 'A complete line.', 0, 1)],
  }, {
    getCurrentScope: () => current,
    yieldControl: () => {
      yields += 1;
      if (yields === 1) current = { ...scope, editRevision: 'edit-2' };
    },
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.rangeProposal, null);
});

test('scope validation rejects stale transcript revisions without relabeling the result', () => {
  assert.throws(() => validateFinalAnalysisScope(scope, { ...scope, transcriptRevision: 'transcript-2' }), FinalAnalysisStaleError);
});

test('malformed, duplicate, foreign, and ambiguous scoped evidence is rejected', () => {
  assert.throws(() => createFinalAnalysis({
    scope,
    jobId: 'job-duplicate',
    sourceDuration: 3,
    observations: [observation('same', 'One.', 0, 1), observation('same', 'One.', 1, 2)],
  }), /duplicate speech observation id/);
  assert.throws(() => createFinalAnalysis({
    scope,
    jobId: 'job-foreign',
    sourceDuration: 3,
    observations: [observation('foreign', 'One.', 0, 1, { sourceId: 'other-source' })],
  }), /another source/);
  assert.throws(() => createFinalAnalysis({
    scope,
    jobId: 'job-ambiguous',
    sourceDuration: 3,
    observations: [
      observation('a', 'One.', 0, 1, { takeId: 'take-ambiguous', utteranceId: 'utterance', revision: 1 }),
      observation('b', 'One.', 1, 2, { takeId: 'take-ambiguous', utteranceId: 'utterance', revision: 1 }),
    ],
  }), /duplicate speech revision chain/);
  assert.throws(() => createFinalAnalysis({
    scope,
    jobId: 'job-silence-outside',
    sourceDuration: 3,
    observations: [],
    silences: [{ id: 'quiet', t0: 1, t1: 4 }],
  }), /exceeds source duration/);
  assert.throws(() => createFinalAnalysis({
    scope,
    jobId: 'job-signal-duplicate',
    sourceDuration: 3,
    observations: [],
    signals: { gaze: { observationIds: ['gaze-1', 'gaze-1'] } },
  }), /duplicate gaze signal observation id/);
  assert.throws(() => createFinalAnalysis({
    ...scope,
    jobId: 'job-missing-transcript-revision',
    sourceDuration: 3,
    observations: [],
    scope: { ...scope, transcriptRevision: undefined },
  }), /transcriptRevision/);
});
