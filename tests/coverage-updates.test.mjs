import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMediaAvailability,
  applyScriptChangeIntent,
  coverageLedger,
  coverageSafeToWrap,
  selectedCutOrder,
} from '../src/lib/coverage-updates.ts';
import {
  createScriptLine,
  createTranscriptSegment,
  deriveReviewState,
  selectTake,
} from '../src/lib/transcript-workflow.ts';

function line(id, text, actionCues) {
  return createScriptLine({ id, text, actionCues });
}

function segment(id, t0, t1, text, isFinal = true) {
  return createTranscriptSegment({ id, t0, t1, text, isFinal, revision: 1 });
}

function take(id, segmentIds, overrides = {}) {
  return {
    id,
    t0: overrides.t0 ?? 0,
    t1: overrides.t1 ?? 2,
    mediaUri: overrides.mediaUri ?? `file:///fixtures/${id}.mp4`,
    playable: overrides.playable ?? true,
    quality: overrides.quality ?? 'clean',
    inFrame: overrides.inFrame ?? true,
    transcriptSegmentIds: segmentIds,
    lineIds: overrides.lineIds,
  };
}

function entry(ledger, lineId) {
  const found = ledger.entries.find((item) => item.lineId === lineId);
  assert.ok(found, `expected a ledger entry for ${lineId}`);
  return found;
}

function twoLineLedger() {
  const lines = [line('a', 'Say hello'), line('b', 'Say goodbye')];
  const segments = [segment('s-a', 0, 1, 'say hello'), segment('s-b', 2, 3, 'say goodbye')];
  return coverageLedger(deriveReviewState({
    lines,
    segments,
    takes: [
      take('good-a', ['s-a'], { t0: 0, t1: 1, lineIds: ['a'] }),
      take('bad-a', ['s-a'], { t0: 4, t1: 5, quality: 'flub', lineIds: ['a'] }),
      take('good-b', ['s-b'], { t0: 2, t1: 3, lineIds: ['b'] }),
    ],
  }));
}

test('the coverage ledger keeps every take of a line, including the rejected attempts', () => {
  const ledger = twoLineLedger();

  assert.deepEqual(ledger.entries.map(({ lineId, status, selectedTakeId, reason }) => ({
    lineId,
    status,
    selectedTakeId,
    reason,
  })), [
    { lineId: 'a', status: 'covered', selectedTakeId: 'good-a', reason: 'clean-take' },
    { lineId: 'b', status: 'covered', selectedTakeId: 'good-b', reason: 'clean-take' },
  ]);
  assert.deepEqual(entry(ledger, 'a').history.map(({ takeId, eligible }) => [takeId, eligible]), [
    ['good-a', true],
    ['bad-a', false],
  ]);
  assert.deepEqual(ledger.retired, []);
  assert.equal(coverageSafeToWrap(ledger), true);
  assert.equal(coverageSafeToWrap(ledger, ['cue-smile']), false);
});

test('editing a covered line resets it to needed and retains its take history', () => {
  const changed = applyScriptChangeIntent(twoLineLedger(), {
    editedLineIds: ['a'],
    deletedLineIds: [],
    addedLineIds: [],
  });

  assert.deepEqual(
    (({ status, selectedTakeId, reason }) => ({ status, selectedTakeId, reason }))(entry(changed, 'a')),
    { status: 'needed', selectedTakeId: null, reason: 'script-edited' },
  );
  assert.deepEqual(entry(changed, 'a').history.map(({ takeId }) => takeId), ['good-a', 'bad-a']);
  assert.equal(entry(changed, 'b').status, 'covered');
  assert.equal(coverageSafeToWrap(changed), false);
});

test('deleting a line retires it with its takes instead of destroying the evidence', () => {
  const changed = applyScriptChangeIntent(twoLineLedger(), {
    editedLineIds: [],
    deletedLineIds: ['b'],
    addedLineIds: [],
  });

  assert.deepEqual(changed.entries.map(({ lineId }) => lineId), ['a']);
  assert.deepEqual(changed.retired.map(({ lineId, reason, status }) => ({ lineId, reason, status })), [
    { lineId: 'b', reason: 'line-deleted', status: 'covered' },
  ]);
  assert.deepEqual(changed.retired[0].history.map(({ takeId }) => takeId), ['good-b']);
  assert.deepEqual(selectedCutOrder(changed).map(({ takeId }) => takeId), ['good-a']);
});

test('added lines start as needed and never inherit another line take', () => {
  const changed = applyScriptChangeIntent(twoLineLedger(), {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: ['c'],
  });

  assert.deepEqual(
    (({ status, selectedTakeId, reason, history }) => ({ status, selectedTakeId, reason, history }))(entry(changed, 'c')),
    { status: 'needed', selectedTakeId: null, reason: 'line-added', history: [] },
  );
  assert.throws(() => applyScriptChangeIntent(changed, {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: ['a'],
  }), /already/);
});

test('a reorder keeps every line id and its coverage, and a mismatched reorder is rejected', () => {
  const ledger = twoLineLedger();
  const reordered = applyScriptChangeIntent(ledger, {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: [],
    reorderedFrom: ['a', 'b'],
  });

  assert.deepEqual(reordered.entries, ledger.entries);
  assert.throws(() => applyScriptChangeIntent(ledger, {
    editedLineIds: [],
    deletedLineIds: [],
    addedLineIds: [],
    reorderedFrom: ['a'],
  }), /reorderedFrom/);
  assert.throws(() => applyScriptChangeIntent(ledger, {
    editedLineIds: ['missing'],
    deletedLineIds: [],
    addedLineIds: [],
  }), /unknown/);
});

test('a take whose media disappears moves its line to needed with reason media-missing', () => {
  const recomputed = applyMediaAvailability(twoLineLedger(), ['good-b']);

  assert.deepEqual(
    (({ status, selectedTakeId, reason }) => ({ status, selectedTakeId, reason }))(entry(recomputed, 'b')),
    { status: 'needed', selectedTakeId: null, reason: 'media-missing' },
  );
  assert.deepEqual(entry(recomputed, 'b').history.map(({ takeId, playable, eligible }) => ({
    takeId,
    playable,
    eligible,
  })), [{ takeId: 'good-b', playable: false, eligible: false }]);
  assert.equal(entry(recomputed, 'a').status, 'covered');
  assert.deepEqual(selectedCutOrder(recomputed).map(({ takeId }) => takeId), ['good-a']);
});

test('missing media falls back to a remaining eligible take instead of losing the line', () => {
  const lines = [line('a', 'Say hello')];
  const segments = [segment('s-a', 0, 1, 'say hello')];
  const ledger = coverageLedger(deriveReviewState({
    lines,
    segments,
    takes: [
      take('first', ['s-a'], { t0: 0, t1: 1, lineIds: ['a'] }),
      take('second', ['s-a'], { t0: 5, t1: 6, lineIds: ['a'] }),
    ],
  }));
  assert.equal(entry(ledger, 'a').selectedTakeId, 'first');

  const recomputed = applyMediaAvailability(ledger, ['first']);
  assert.deepEqual(
    (({ status, selectedTakeId, reason }) => ({ status, selectedTakeId, reason }))(entry(recomputed, 'a')),
    { status: 'covered', selectedTakeId: 'second', reason: 'clean-take' },
  );
  assert.deepEqual(entry(recomputed, 'a').history.map(({ takeId }) => takeId), ['first', 'second']);
});

test('two lines read in one breath stay one cut, and cuts follow script order not recording order', () => {
  const lines = [line('a', 'Start the camera.'), line('b', 'Look into the lens.'), line('c', 'Then stop.')];
  const breath = segment('s-ab', 8, 11, 'Start the camera. Look into the lens.');
  const early = segment('s-c', 1, 2, 'then stop');
  const ledger = coverageLedger(deriveReviewState({
    lines,
    segments: [early, breath],
    takes: [
      take('take-c', ['s-c'], { t0: 1, t1: 2, lineIds: ['c'] }),
      take('take-ab', ['s-ab'], { t0: 8, t1: 11, lineIds: ['a', 'b'] }),
    ],
  }));

  assert.deepEqual(selectedCutOrder(ledger), [
    { takeId: 'take-ab', lineIds: ['a', 'b'], t0: 8, t1: 11 },
    { takeId: 'take-c', lineIds: ['c'], t0: 1, t1: 2 },
  ]);
});

test('a media loss never re-covers a line the creator just edited', () => {
  const lines = [line('a', 'Say hello')];
  const segments = [segment('s-a', 0, 1, 'say hello')];
  const covered = coverageLedger(deriveReviewState({
    lines,
    segments,
    takes: [
      take('t1', ['s-a'], { t0: 0, t1: 1, lineIds: ['a'] }),
      take('t2', ['s-a'], { t0: 5, t1: 6, lineIds: ['a'] }),
    ],
  }));
  assert.equal(entry(covered, 'a').status, 'covered');

  const edited = applyScriptChangeIntent(covered, {
    editedLineIds: ['a'],
    deletedLineIds: [],
    addedLineIds: [],
  });
  assert.equal(entry(edited, 'a').status, 'needed');
  assert.ok(entry(edited, 'a').history.every(({ eligible, stale }) => !eligible && stale));

  const afterLoss = applyMediaAvailability(edited, ['t1']);
  assert.deepEqual(
    (({ status, selectedTakeId, reason }) => ({ status, selectedTakeId, reason }))(entry(afterLoss, 'a')),
    { status: 'needed', selectedTakeId: null, reason: 'script-edited' },
  );
  assert.deepEqual(entry(afterLoss, 'a').history.map(({ takeId }) => takeId), ['t1', 't2']);
  assert.deepEqual(selectedCutOrder(afterLoss), []);
});

test('a media loss never replaces an explicit take choice or promotes a pending line', () => {
  const lines = [line('a', 'Say hello')];
  const segments = [segment('s-a', 0, 1, 'say hello')];
  const takes = [
    take('t1', ['s-a'], { t0: 0, t1: 1, lineIds: ['a'] }),
    take('t2', ['s-a'], { t0: 5, t1: 6, lineIds: ['a'] }),
  ];
  const chosen = coverageLedger(deriveReviewState({
    lines,
    segments,
    takes: [takes[0], { ...takes[1], mediaUri: null, playable: false }],
    decisions: selectTake([], 'a', 't2', takes),
  }));
  assert.deepEqual(
    (({ status, selectedTakeId, explicitTakeId, reason }) => ({
      status,
      selectedTakeId,
      explicitTakeId,
      reason,
    }))(entry(chosen, 'a')),
    { status: 'pending', selectedTakeId: null, explicitTakeId: 't2', reason: 'media-unavailable' },
  );

  const afterLoss = applyMediaAvailability(chosen, ['t2']);
  assert.deepEqual(
    (({ status, selectedTakeId, reason }) => ({ status, selectedTakeId, reason }))(entry(afterLoss, 'a')),
    { status: 'needed', selectedTakeId: null, reason: 'media-missing' },
  );
  assert.deepEqual(entry(afterLoss, 'a').history.map(({ takeId }) => takeId), ['t1', 't2']);
  assert.deepEqual(selectedCutOrder(afterLoss), []);
});

test('a later off-frame retake never displaces an earlier in-frame clean take', () => {
  const lines = [line('a', 'Say hello')];
  const segments = [segment('s-a', 0, 1, 'say hello')];
  const ledger = coverageLedger(deriveReviewState({
    lines,
    segments,
    takes: [
      take('in-frame', ['s-a'], { t0: 0, t1: 1, inFrame: true, lineIds: ['a'] }),
      take('off-frame-retake', ['s-a'], { t0: 5, t1: 6, inFrame: false, lineIds: ['a'] }),
    ],
  }));

  assert.equal(entry(ledger, 'a').selectedTakeId, 'in-frame');
  assert.deepEqual(entry(ledger, 'a').history.map(({ takeId }) => takeId), ['in-frame', 'off-frame-retake']);
});

test('a take covering non-adjacent lines is played once, at its first script position', () => {
  const lines = [line('a', 'Say hello'), line('b', 'Say goodbye'), line('c', 'Say later')];
  const spanning = segment('s-ac', 0, 3, 'say hello say later');
  const middle = segment('s-b', 5, 6, 'say goodbye');
  const ledger = coverageLedger(deriveReviewState({
    lines,
    segments: [spanning, middle],
    takes: [
      take('take-ac', ['s-ac'], { t0: 0, t1: 3, lineIds: ['a', 'c'] }),
      take('take-b', ['s-b'], { t0: 5, t1: 6, lineIds: ['b'] }),
    ],
  }));

  // Source audio is never repeated, so the line c cut plays inside the take that
  // also carries line a. Splitting that media is an editor decision.
  assert.deepEqual(selectedCutOrder(ledger), [
    { takeId: 'take-ac', lineIds: ['a', 'c'], t0: 0, t1: 3 },
    { takeId: 'take-b', lineIds: ['b'], t0: 5, t1: 6 },
  ]);
});
