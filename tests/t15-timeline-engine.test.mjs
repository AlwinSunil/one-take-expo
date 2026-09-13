import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTimelineAction,
  createTimelineState,
  playheadAt,
  preserveTimelinePlayhead,
  redoTimeline,
  resolveTimeline,
  undoTimeline,
} from '../src/features/timeline/engine.ts';
import { clip, reasons, snapshot, source } from './fixtures/t15-timeline/index.mjs';

const sources = {
  original: source('original', { uri: 'file:///original.mp4', duration: 20 }),
  pickup: source('pickup', { uri: 'file:///pickup.mp4', duration: 20 }),
};

const reasonList = [reasons.silence, reasons.creator];

function edit(state, action, availableSources = sources) {
  return applyTimelineAction(state, action, availableSources);
}

function ids(state) {
  return state.snapshot.clips.map(item => item.id);
}

function baseAction(state, id, kind, fields = {}) {
  return { id, baseRevision: state.snapshot.revision, kind, ...fields };
}

test('resolves source-local clips into one ordered output and keeps excluded rows out of preview', () => {
  const value = snapshot([
    clip('original-a', 'original', 2, 5),
    clip('pickup-b', 'pickup', 0, 3),
    clip('excluded', 'original', 7, 12, { included: false, reasonIds: [reasons.creator.id] }),
  ], 7);
  const result = resolveTimeline(value, sources);

  assert.equal(result.revision, 7);
  assert.equal(result.duration, 6);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.segments.map(item => ({
    clipId: item.clipId,
    sourceId: item.sourceId,
    uri: item.uri,
    t0: item.t0,
    t1: item.t1,
    outputT0: item.outputT0,
    outputT1: item.outputT1,
  })), [
    { clipId: 'original-a', sourceId: 'original', uri: 'file:///original.mp4', t0: 2, t1: 5, outputT0: 0, outputT1: 3 },
    { clipId: 'pickup-b', sourceId: 'pickup', uri: 'file:///pickup.mp4', t0: 0, t1: 3, outputT0: 3, outputT1: 6 },
  ]);
});

test('empty included sequence is an empty preview with zero duration and no original fallback', () => {
  const value = snapshot([
    clip('excluded-a', 'original', 0, 10, { included: false, reasonIds: [reasons.creator.id] }),
  ]);
  const result = resolveTimeline(value, sources);
  assert.deepEqual(result.segments, []);
  assert.equal(result.duration, 0);
  assert.deepEqual(result.issues, []);
});

test('resolver reports invalid, missing, unavailable and unknown ranges while retaining valid output evidence', () => {
  const value = snapshot([
    clip('valid', 'original', 0, 2),
    clip('zero', 'original', 2, 2),
    clip('negative', 'original', -1, 1),
    clip('outside', 'original', 19, 21),
    clip('missing', 'not-attached', 0, 2),
    clip('unavailable', 'pickup', 0, 2),
    clip('unknown-duration', 'unknown', 0, 2),
  ], 4);
  const result = resolveTimeline(value, {
    ...sources,
    pickup: source('pickup', { available: false }),
    unknown: source('unknown', { duration: null }),
  });

  assert.equal(result.duration, 2);
  assert.deepEqual(result.segments.map(item => item.clipId), ['valid']);
  assert.equal(result.issues.length, 6);
  assert.ok(result.issues.every(issue => issue.recovery && issue.message));
  assert.ok(result.issues.some(issue => issue.code === 'invalid-range' && issue.clipId === 'zero'));
  assert.ok(result.issues.some(issue => issue.code === 'invalid-range' && issue.clipId === 'outside'));
  assert.ok(result.issues.some(issue => issue.code === 'unavailable' && issue.clipId === 'missing'));
  assert.ok(result.issues.some(issue => issue.code === 'unavailable' && issue.clipId === 'unavailable'));
  assert.ok(result.issues.some(issue => issue.code === 'unknown-duration' && issue.clipId === 'unknown-duration'));
});

test('compound trim, split, exclude, reorder, multi-step undo/redo, reopen and export use one canonical sequence', () => {
  const initial = createTimelineState(snapshot([
    clip('a', 'original', 0, 10),
    clip('b', 'original', 10, 15),
  ]));
  const originalSnapshot = structuredClone(initial.snapshot);

  let state = edit(initial, baseAction(initial, 'trim-1', 'trim', { clipId: 'a', t0: 1, t1: 9 }));
  assert.equal(state.snapshot.revision, 1);
  state = edit(state, baseAction(state, 'split-1', 'split', { clipId: 'a', at: 5, leftId: 'a-left', rightId: 'a-right' }));
  assert.equal(state.snapshot.revision, 2);
  assert.deepEqual(ids(state), ['a-left', 'a-right', 'b']);
  assert.deepEqual(state.snapshot.clips[0].parentClipId, 'a');
  assert.deepEqual(state.snapshot.clips[1].parentClipId, 'a');
  state = edit(state, baseAction(state, 'exclude-1', 'exclude', { clipId: 'a-right' }));
  state = edit(state, baseAction(state, 'reorder-1', 'reorder', { clipId: 'b', index: 0 }));
  assert.deepEqual(ids(state), ['b', 'a-left', 'a-right']);
  assert.equal(state.snapshot.clips.at(-1).included, false);

  let output = resolveTimeline(state.snapshot, sources);
  assert.equal(output.issues.length, 0);
  assert.equal(output.duration, 9);
  assert.deepEqual(output.segments.map(item => [item.clipId, item.outputT0, item.outputT1]), [
    ['b', 0, 5],
    ['a-left', 5, 9],
  ]);

  const revisions = [state.snapshot.revision];
  state = undoTimeline(state);
  revisions.push(state.snapshot.revision);
  assert.deepEqual(ids(state), ['a-left', 'a-right', 'b']);
  state = undoTimeline(state);
  revisions.push(state.snapshot.revision);
  assert.equal(state.snapshot.clips.find(item => item.id === 'a-right').included, true);
  state = redoTimeline(state);
  revisions.push(state.snapshot.revision);
  assert.equal(state.snapshot.clips.find(item => item.id === 'a-right').included, false);
  state = redoTimeline(state);
  revisions.push(state.snapshot.revision);
  assert.deepEqual(ids(state), ['b', 'a-left', 'a-right']);
  assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]));

  const reopened = JSON.parse(JSON.stringify(state));
  const restored = createTimelineState(reopened.snapshot, reopened.reasons, reopened.history);
  assert.equal(restored.snapshot.revision, state.snapshot.revision);
  assert.deepEqual(restored.snapshot, state.snapshot);
  assert.equal(restored.history.cursor, state.history.cursor);
  output = resolveTimeline(restored.snapshot, sources);
  assert.equal(output.duration, 9);
  assert.equal(output.issues.length, 0);
  assert.deepEqual(originalSnapshot, initial.snapshot);
});

test('a new creator edit after undo abandons redo entries while retaining their evidence', () => {
  let state = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  state = edit(state, baseAction(state, 'trim-1', 'trim', { clipId: 'a', t0: 1, t1: 9 }));
  state = edit(state, baseAction(state, 'trim-2', 'trim', { clipId: 'a', t0: 2, t1: 8 }));
  state = undoTimeline(state);
  const undoneRevision = state.snapshot.revision;
  assert.equal(state.history.cursor, 1);
  assert.equal(state.history.entries.length, 2);
  state = edit(state, baseAction(state, 'trim-after-undo', 'trim', { clipId: 'a', t0: 3, t1: 7 }));
  assert.equal(state.snapshot.revision, undoneRevision + 1);
  assert.equal(state.history.cursor, 2);
  assert.deepEqual(state.history.abandonedEntries.map(command => command.id), ['trim-2']);
  assert.equal(redoTimeline(state), state);
});

test('split keeps stable lineage and a shared utterance is never duplicated automatically', () => {
  const initial = createTimelineState(snapshot([
    clip('source-clip', 'original', 0, 10, {
      spanIds: ['span-shared'],
      pointIds: ['point-a', 'point-b'],
      utteranceIds: ['utterance-shared'],
    }),
  ]));
  const before = initial.snapshot.clips[0];
  const next = edit(initial, baseAction(initial, 'split-shared', 'split', {
    clipId: before.id,
    at: 4,
    leftId: 'source-clip-left',
    rightId: 'source-clip-right',
  }));
  const children = next.snapshot.clips;
  assert.deepEqual(children.map(item => item.parentClipId), ['source-clip', 'source-clip']);
  assert.equal(children[0].t1, children[1].t0);
  assert.deepEqual([children[0].t0, children[1].t1], [before.t0, before.t1]);
  for (const key of ['spanIds', 'pointIds', 'utteranceIds']) {
    assert.deepEqual(children[0][key], before[key]);
    assert.deepEqual(children[1][key], before[key]);
    const identities = new Set(children.flatMap(item => item[key]));
    assert.deepEqual(identities, new Set(before[key]));
  }
});

test('source-local playhead follows a split descendant and clamps to the next output interval when removed', () => {
  const initial = createTimelineState(snapshot([
    clip('a', 'original', 0, 10),
    clip('b', 'pickup', 0, 4),
  ]));
  const firstSequence = resolveTimeline(initial.snapshot, sources);
  const previous = playheadAt(firstSequence, 5);
  assert.deepEqual(previous, { clipId: 'a', sourceId: 'original', sourceTime: 5, outputTime: 5 });

  const split = edit(initial, baseAction(initial, 'split-a', 'split', {
    clipId: 'a', at: 4, leftId: 'a-left', rightId: 'a-right',
  }));
  const preserved = preserveTimelinePlayhead(previous, split, sources);
  assert.equal(preserved.clipId, 'a-right');
  assert.equal(preserved.sourceId, 'original');
  assert.equal(preserved.sourceTime, 5);

  const excluded = edit(split, baseAction(split, 'exclude-right', 'exclude', { clipId: 'a-right' }));
  const moved = preserveTimelinePlayhead(preserved, excluded, sources);
  assert.equal(moved.clipId, 'b');
  assert.equal(moved.sourceId, 'pickup');
  assert.equal(moved.sourceTime, 1);
});

test('trim and split reject zero-length, out-of-bounds and unavailable edits with recovery text', () => {
  const initial = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  assert.throws(() => edit(initial, baseAction(initial, 'trim-zero', 'trim', { clipId: 'a', t0: 3, t1: 3 })), /Adjust trim bounds/);
  assert.throws(() => edit(initial, baseAction(initial, 'trim-outside', 'trim', { clipId: 'a', t0: -1, t1: 4 })), /Adjust trim bounds/);
  assert.throws(() => edit(initial, baseAction(initial, 'split-edge', 'split', { clipId: 'a', at: 0, leftId: 'left', rightId: 'right' })), /inside an included clip/);
  assert.throws(() => edit(initial, baseAction(initial, 'trim-missing', 'trim', { clipId: 'a', t0: 1, t1: 2 }), {
    original: source('original', { available: false }),
  }), /unavailable/);
  assert.deepEqual(initial.snapshot.clips, [clip('a', 'original', 0, 10)]);
});

test('whole proposal and take choice are explicit undoable commands and preserve source isolation', () => {
  let state = createTimelineState(snapshot([
    clip('original-slot', 'original', 1, 4, { pointIds: ['point-a'] }),
  ]));
  const pickup = clip('pickup-slot', 'pickup', 7, 11, {
    takeId: 'take-pickup',
    parentClipId: 'original-slot',
    pointIds: ['point-a'],
    spanIds: ['span-a'],
    utteranceIds: ['utterance-a'],
  });
  state = edit(state, baseAction(state, 'take-choice-1', 'choose-take', { clips: [pickup] }));
  assert.equal(state.history.entries.at(-1).kind, 'choose-take');
  assert.equal(state.snapshot.clips.find(item => item.id === 'original-slot').included, false);
  assert.equal(state.snapshot.clips.find(item => item.id === 'pickup-slot').takeId, 'take-pickup');
  let output = resolveTimeline(state.snapshot, sources);
  assert.deepEqual(output.segments.map(item => [item.sourceId, item.t0, item.t1, item.takeId]), [['pickup', 7, 11, 'take-pickup']]);

  const beforeProposal = state;
  const proposalClip = clip('proposal-slot', 'original', 12, 15, { pointIds: ['point-c'] });
  state = edit(state, baseAction(state, 'accept-proposal-1', 'accept-proposal', { clips: [proposalClip] }));
  assert.equal(state.history.entries.at(-1).kind, 'accept-proposal');
  assert.equal(state.snapshot.clips.find(item => item.id === 'proposal-slot').included, true);
  assert.equal(state.snapshot.clips.find(item => item.id === 'pickup-slot').included, false);
  const proposalRevision = state.snapshot.revision;
  state = undoTimeline(state);
  assert.deepEqual(state.snapshot.clips, beforeProposal.snapshot.clips);
  assert.equal(state.snapshot.revision, proposalRevision + 1);
  output = resolveTimeline(state.snapshot, sources);
  assert.equal(output.segments[0].sourceId, 'pickup');
  assert.equal(output.issues.length, 0);
});

test('a command prepared against an older revision is rejected without changing the current timeline', () => {
  const initial = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  const current = edit(initial, baseAction(initial, 'trim-current', 'trim', { clipId: 'a', t0: 1, t1: 9 }));
  assert.throws(() => edit(current, {
    id: 'trim-stale', baseRevision: initial.snapshot.revision, kind: 'trim', clipId: 'a', t0: 2, t1: 8,
  }), /stale|current timeline/i);
  assert.deepEqual(current.snapshot.clips, [clip('a', 'original', 1, 9)]);
});

test('command IDs and split child IDs cannot be reused from active or abandoned history', () => {
  let state = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  state = edit(state, baseAction(state, 'command-1', 'trim', { clipId: 'a', t0: 1, t1: 9 }));
  state = edit(state, baseAction(state, 'command-2', 'trim', { clipId: 'a', t0: 2, t1: 8 }));
  state = undoTimeline(state);
  state = edit(state, baseAction(state, 'command-3', 'trim', { clipId: 'a', t0: 3, t1: 7 }));
  assert.deepEqual(state.history.abandonedEntries.map(command => command.id), ['command-2']);
  assert.throws(() => edit(state, baseAction(state, 'command-2', 'trim', { clipId: 'a', t0: 4, t1: 6 })), /new command identity/i);

  let splitState = createTimelineState(snapshot([clip('split-source', 'original', 0, 10)]));
  splitState = edit(splitState, baseAction(splitState, 'split-1', 'split', {
    clipId: 'split-source', at: 4, leftId: 'split-left', rightId: 'split-right',
  }));
  splitState = undoTimeline(splitState);
  assert.throws(() => edit(splitState, baseAction(splitState, 'split-2', 'split', {
    clipId: 'split-source', at: 6, leftId: 'split-left', rightId: 'split-right',
  })), /new stable clip identities/i);
});

test('reopening a snapshot with a contradictory history cursor is rejected', () => {
  let state = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  state = edit(state, baseAction(state, 'trim-1', 'trim', { clipId: 'a', t0: 1, t1: 9 }));
  const contradictoryHistory = structuredClone(state.history);
  contradictoryHistory.cursor = 0;
  assert.throws(() => createTimelineState(state.snapshot, state.reasons, contradictoryHistory), /history|snapshot|reopen/i);
});

test('accepting a proposal with the same whole utterance in separate clips requires visible review', () => {
  const initial = createTimelineState(snapshot([]));
  const duplicateWholeUtterance = [
    clip('proposal-a', 'pickup', 1, 4, {
      spanIds: ['span-shared'], pointIds: ['point-a'], utteranceIds: ['utterance-shared'],
    }),
    clip('proposal-b', 'pickup', 1, 4, {
      spanIds: ['span-shared'], pointIds: ['point-b'], utteranceIds: ['utterance-shared'],
    }),
  ];
  assert.throws(() => edit(initial, baseAction(initial, 'accept-duplicate', 'accept-proposal', {
    clips: duplicateWholeUtterance,
  })), /utterance|duplicate|review|conflict/i);
  assert.deepEqual(initial.snapshot.clips, []);
});

test('automatic acceptance cannot restore a creator exclusion, while choose-take is explicit', () => {
  const creatorExclusion = { id: 'reason:creator-exclusion', kind: 'exclude', text: 'Creator excluded this range', actor: 'creator' };
  const initial = createTimelineState(snapshot([
    clip('excluded', 'original', 0, 5, { included: false, reasonIds: [creatorExclusion.id] }),
  ]), [creatorExclusion]);
  const candidate = clip('excluded', 'original', 0, 5, { reasonIds: [] });

  assert.throws(() => edit(initial, baseAction(initial, 'accept-reinclude', 'accept-proposal', { clips: [candidate] })), /restore|excluded/i);
  assert.equal(initial.snapshot.clips[0].included, false);

  const chosen = edit(initial, baseAction(initial, 'choose-reinclude', 'choose-take', { clips: [candidate] }));
  assert.equal(chosen.snapshot.clips[0].included, true);
  assert.ok(chosen.snapshot.clips[0].reasonIds.includes(creatorExclusion.id));
});

test('automatic acceptance rejects disjoint new same-source utterance duplication but keeps unchanged split descendants', () => {
  const initial = createTimelineState(snapshot([clip('source', 'original', 0, 10, { utteranceIds: ['shared'] })]));
  const duplicate = [
    clip('new-left', 'original', 0, 4, { utteranceIds: ['shared'] }),
    clip('new-right', 'original', 4, 8, { utteranceIds: ['shared'] }),
  ];
  assert.throws(() => edit(initial, baseAction(initial, 'accept-duplicate-disjoint', 'accept-proposal', { clips: duplicate })), /split|duplicate|utterance|review/i);

  const split = edit(initial, baseAction(initial, 'explicit-split', 'split', {
    clipId: 'source', at: 4, leftId: 'source-left', rightId: 'source-right',
  }));
  const accepted = edit(split, baseAction(split, 'accept-unchanged-split', 'accept-proposal', { clips: split.snapshot.clips }));
  assert.deepEqual(accepted.snapshot.clips.map(item => item.id), ['source-left', 'source-right']);
});

test('acceptance reserves every historical clip identity, including abandoned and non-split commands', () => {
  for (const kind of ['accept-proposal', 'accept-pickup', 'choose-take']) {
    let state = createTimelineState(snapshot([clip('source', 'original', 0, 10)]));
    state = edit(state, baseAction(state, `split-for-${kind}`, 'split', {
      clipId: 'source', at: 4, leftId: `${kind}-left`, rightId: `${kind}-right`,
    }));
    state = undoTimeline(state);
    const historical = clip(`${kind}-left`, 'original', 0, 4, { parentClipId: 'source' });
    assert.throws(() => edit(state, baseAction(state, `reuse-${kind}`, kind, { clips: [historical] })), /stable identit|historical|reuse/i);
  }
});

test('reopen validates all command snapshots, references, metadata and revisions before undo', () => {
  let state = createTimelineState(snapshot([clip('a', 'original', 0, 10)]));
  state = edit(state, { ...baseAction(state, 'trim-validate', 'trim', { clipId: 'a', t0: 1, t1: 9 }), metadata: { proposalId: 'proposal-1', accepted: true } });

  const reordered = structuredClone(state.history);
  const stored = reordered.entries[0].after[0];
  reordered.entries[0].after[0] = {
    utteranceIds: stored.utteranceIds,
    pointIds: stored.pointIds,
    id: stored.id,
    t1: stored.t1,
    included: stored.included,
    sourceId: stored.sourceId,
    reasonIds: stored.reasonIds,
    spanIds: stored.spanIds,
    t0: stored.t0,
  };
  assert.doesNotThrow(() => createTimelineState(state.snapshot, state.reasons, reordered));

  const malformed = [
    history => { history.entries[0].kind = 'unknown'; },
    history => { history.entries[0].baseRevision = Number.MAX_SAFE_INTEGER; },
    history => { history.entries[0].revision = history.entries[0].baseRevision; },
    history => { history.entries[0].reasonIds = ['missing-reason']; },
    history => { history.entries[0].after.push(structuredClone(history.entries[0].after[0])); },
    history => { history.entries[0].before[0].reasonIds = ['missing-reason']; },
    history => { history.entries[0].metadata = { broken: NaN }; },
  ];
  for (const mutate of malformed) {
    const broken = structuredClone(state.history);
    mutate(broken);
    assert.throws(() => createTimelineState(state.snapshot, state.reasons, broken), /history|reason|metadata|revision|identity|clip/i);
  }
  assert.throws(() => createTimelineState(snapshot([clip('a', 'original', 0, 10)]), [{ id: 'bad', kind: '', text: 'bad', actor: 'creator' }]), /reason/i);
});
