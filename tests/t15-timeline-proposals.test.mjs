import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptPickupProposal, buildPickupProposal } from '../src/features/timeline/proposals.ts';

const scope = (overrides = {}) => ({
  captured: {
    projectId: 'project-1',
    scriptRevision: 4,
    editRevision: 7,
    pointRevision: 3,
    transcriptRevision: 9,
    sourceTranscriptRevisions: { original: 1, pickup: 2, 'camera-a': 3, 'camera-b': 4 },
    pointRevisions: { 'point-a': 1, 'point-b': 1, 'point-c': 1 },
    ...overrides.captured,
  },
  current: {
    projectId: 'project-1',
    scriptRevision: 4,
    editRevision: 7,
    pointRevision: 3,
    transcriptRevision: 9,
    sourceTranscriptRevisions: { original: 1, pickup: 2, 'camera-a': 3, 'camera-b': 4 },
    pointRevisions: { 'point-a': 1, 'point-b': 1, 'point-c': 1 },
    ...overrides.current,
  },
});

const source = (id, uri = `file:///${id}.mp4`, extra = {}) => ({ id, uri, duration: 20, available: true, ...extra });

const clip = (id, sourceId, t0, t1, pointId, extra = {}) => ({
  id,
  sourceId,
  t0,
  t1,
  included: true,
  reasonIds: [],
  spanIds: [`span-${pointId}`],
  pointIds: [pointId],
  utteranceIds: [`utterance-${pointId}`],
  ...extra,
});

const intent = (id, sourceId, t0, t1, pointId, extra = {}) => ({
  id,
  clipId: `clip-${id}`,
  sourceId,
  t0,
  t1,
  pointIds: [pointId],
  spanIds: [`span-${pointId}`],
  utteranceIds: [`utterance-${id}`],
  ...extra,
});

const input = (overrides = {}) => ({
  proposalId: 'proposal-1',
  snapshot: { revision: 7, clips: [] },
  sources: [source('original'), source('pickup')],
  intents: [intent('b', 'pickup', 0, 1, 'point-b')],
  pointOrder: { 'point-a': 0, 'point-b': 1, 'point-c': 2 },
  scope: scope(),
  ...overrides,
});

test('pickup proposal inserts B between A and C while retaining source-local times', () => {
  const snapshot = {
    revision: 7,
    clips: [clip('clip-a', 'original', 2, 3, 'point-a'), clip('clip-c', 'original', 8, 9, 'point-c')],
  };
  const result = buildPickupProposal(input({ snapshot }));

  assert.equal(result.status, 'pending');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.candidateClips.map(item => [item.id, item.sourceId, item.t0, item.t1]), [['clip-b', 'pickup', 0, 1]]);
  assert.deepEqual(snapshot.clips.map(item => item.id), ['clip-a', 'clip-c']);

  assert.deepEqual(result.previewClips.map(item => item.id), ['clip-a', 'clip-b', 'clip-c']);
  const accepted = acceptPickupProposal({ snapshot, proposal: result.proposal, commandId: 'command-pickup-b', acceptedAt: 42, sources: input().sources, currentScope: scope().current });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.after.map(item => item.id), ['clip-a', 'clip-b', 'clip-c']);
  assert.deepEqual(accepted.after.map(item => item.sourceId), ['original', 'pickup', 'original']);
  assert.deepEqual(accepted.after.find(item => item.id === 'clip-b').pointIds, ['point-b']);
  assert.equal(accepted.command.kind, 'accept-pickup');
  assert.equal(accepted.command.baseRevision, 7);
  assert.deepEqual(accepted.command.clips.map(item => item.id), ['clip-a', 'clip-b', 'clip-c']);
  assert.equal(accepted.acceptance.acceptedBy, 'creator');
});

test('reverse-order pickup intents are sorted by intended point order', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-reverse',
    intents: [intent('c', 'pickup', 4, 5, 'point-c'), intent('b', 'pickup', 0, 1, 'point-b')],
  }));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.candidateClips.map(item => item.pointIds[0]), ['point-b', 'point-c']);

  assert.deepEqual(result.previewClips.map(item => item.pointIds[0]), ['point-b', 'point-c']);
  const accepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: result.proposal, sources: input().sources, currentScope: scope().current });
  assert.deepEqual(accepted.after.map(item => item.pointIds[0]), ['point-b', 'point-c']);
});

test('equal source-local timestamps from different sources remain separate clips', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-sources',
    sources: [source('camera-a'), source('camera-b')],
    intents: [
      intent('a', 'camera-a', 2, 3, 'point-a', { utteranceIds: ['utterance-a'] }),
      intent('b', 'camera-b', 2, 3, 'point-b', { utteranceIds: ['utterance-a'] }),
    ],
  }));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.candidateClips.map(item => [item.sourceId, item.t0, item.t1]), [['camera-a', 2, 3], ['camera-b', 2, 3]]);
  const accepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: result.proposal, sources: [source('camera-a'), source('camera-b')], currentScope: scope().current });
  assert.deepEqual(accepted.after.map(item => item.sourceId), ['camera-a', 'camera-b']);
});

test('one shared utterance remains one whole range with all point and span identities', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-shared',
    intents: [intent('shared', 'pickup', 1, 3, 'point-a', {
      pointIds: ['point-a', 'point-b'],
      spanIds: ['span-a', 'span-b'],
      utteranceIds: ['utterance-shared'],
    })],
  }));
  assert.equal(result.status, 'pending');
  assert.equal(result.candidateClips.length, 1);
  assert.deepEqual(result.candidateClips[0].pointIds, ['point-a', 'point-b']);
  assert.deepEqual(result.candidateClips[0].spanIds, ['span-a', 'span-b']);
  assert.deepEqual(result.candidateClips[0].utteranceIds, ['utterance-shared']);
});

test('same shared utterance can be reported twice at the same range without duplication', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-shared-repeat',
    intents: [
      intent('shared-a', 'pickup', 1, 3, 'point-a', { clipId: 'shared-clip', utteranceIds: ['utterance-shared'] }),
      intent('shared-b', 'pickup', 1, 3, 'point-b', { clipId: 'shared-clip', utteranceIds: ['utterance-shared'] }),
    ],
  }));
  assert.equal(result.status, 'pending');
  assert.equal(result.candidateClips.length, 1);
  assert.deepEqual(result.candidateClips[0].pointIds, ['point-a', 'point-b']);
});

test('non-adjacent points in a shared utterance require a boundary review', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-gap',
    intents: [intent('gap', 'pickup', 1, 3, 'point-a', {
      pointIds: ['point-a', 'point-c'],
      spanIds: ['span-a', 'span-c'],
      utteranceIds: ['utterance-shared'],
    })],
  }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.some(item => item.kind === 'non-adjacent-utterance'));
  assert.equal(result.conflicts.find(item => item.kind === 'non-adjacent-utterance').recovery, 'review-boundary');
});

test('overlapping distinct utterances are rejected instead of split automatically', () => {
  const result = buildPickupProposal(input({
    proposalId: 'proposal-overlap',
    intents: [
      intent('first', 'pickup', 1, 3, 'point-a'),
      intent('second', 'pickup', 2, 4, 'point-b'),
    ],
  }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.some(item => item.kind === 'overlapping-utterance'));
  assert.equal(result.candidateClips.length, 0);
});

test('unavailable pickup media returns a visible restore action', () => {
  const result = buildPickupProposal(input({
    sources: [source('pickup', undefined, { available: false })],
  }));
  assert.equal(result.status, 'conflict');
  const missing = result.conflicts.find(item => item.kind === 'missing-media');
  assert.ok(missing);
  assert.equal(missing.recovery, 'restore-media');
});

test('unknown source duration blocks an included pickup until the source is probed', () => {
  const result = buildPickupProposal(input({ sources: [source('pickup', undefined, { duration: null })] }));
  assert.equal(result.status, 'conflict');
  const range = result.conflicts.find(item => item.kind === 'invalid-range');
  assert.ok(range);
  assert.equal(range.recovery, 'retry-with-current-scope');
});

test('invalid zero-length and out-of-bounds ranges return boundary recovery', () => {
  for (const bad of [intent('zero', 'pickup', 2, 2, 'point-b'), intent('outside', 'pickup', 19, 21, 'point-b')]) {
    const result = buildPickupProposal(input({ intents: [bad] }));
    assert.equal(result.status, 'conflict');
    assert.ok(result.conflicts.some(item => item.kind === 'invalid-range'));
    assert.equal(result.conflicts.find(item => item.kind === 'invalid-range').recovery, 'review-boundary');
  }
});

test('global and identity-specific stale scopes wait for a refreshed proposal', () => {
  const result = buildPickupProposal(input({
    scope: scope({
      captured: {
        projectId: 'old-project',
        scriptRevision: 3,
        editRevision: 6,
        pointRevision: 2,
        transcriptRevision: 8,
        sourceTranscriptRevisions: { pickup: 2 },
        pointRevisions: { 'point-b': 1 },
      },
      current: {
        projectId: 'project-1',
        scriptRevision: 4,
        editRevision: 7,
        pointRevision: 3,
        transcriptRevision: 9,
        sourceTranscriptRevisions: { pickup: 3 },
        pointRevisions: { 'point-b': 2 },
      },
    }),
  }));
  assert.equal(result.status, 'conflict');
  assert.deepEqual(new Set(result.conflicts.map(item => item.kind)), new Set(['stale-project', 'stale-script', 'stale-edit', 'stale-point', 'stale-transcript']));
  assert.ok(result.conflicts.every(item => item.recovery === 'retry-with-current-scope'));
});

test('per-source transcript and per-point revision maps are required for every referenced identity', () => {
  const baseline = scope();
  const missingSource = buildPickupProposal(input({
    proposalId: 'proposal-missing-source-map',
    scope: {
      captured: { ...baseline.captured, sourceTranscriptRevisions: {} },
      current: { ...baseline.current, sourceTranscriptRevisions: {} },
    },
  }));
  assert.equal(missingSource.status, 'conflict');
  assert.ok(missingSource.conflicts.some(item => item.kind === 'stale-transcript'));

  const built = buildPickupProposal(input({ proposalId: 'proposal-missing-point-map' }));
  const missingPoint = acceptPickupProposal({
    snapshot: input().snapshot,
    proposal: built.proposal,
    sources: input().sources,
    currentScope: { ...baseline.current, pointRevisions: {} },
  });
  assert.equal(missingPoint.status, 'conflict');
  assert.ok(missingPoint.conflicts.some(item => item.kind === 'stale-point'));
  assert.equal(missingPoint.command, undefined);
});

test('captured revision maps are copied before a proposal is retained', () => {
  const captured = scope();
  const built = buildPickupProposal(input({ proposalId: 'proposal-cloned-scope', scope: captured }));
  captured.captured.sourceTranscriptRevisions.pickup = 3;
  const current = scope().current;
  current.sourceTranscriptRevisions.pickup = 3;

  const accepted = acceptPickupProposal({
    snapshot: input().snapshot,
    proposal: built.proposal,
    sources: input().sources,
    currentScope: current,
  });
  assert.equal(accepted.status, 'conflict');
  assert.ok(accepted.conflicts.some(item => item.kind === 'stale-transcript'));
});

test('manual reorder, split and delete edits require visible resolution', () => {
  const result = buildPickupProposal(input({
    baseRevision: 7,
    manualEdits: [
      { id: 'manual-reorder', kind: 'reorder', revision: 8 },
      { id: 'manual-split', kind: 'split', revision: 8, pointIds: ['point-b'] },
      { id: 'manual-delete', kind: 'delete', revision: 8, pointIds: ['point-b'] },
    ],
  }));
  assert.equal(result.status, 'conflict');
  assert.deepEqual(new Set(result.conflicts.map(item => item.kind)), new Set(['manual-reorder', 'manual-split', 'manual-delete']));
  assert.ok(result.conflicts.every(item => item.recovery === 'review-manual-edit'));

  const unrelated = buildPickupProposal(input({
    proposalId: 'proposal-unrelated-manual',
    manualEdits: [
      { id: 'other-split', kind: 'split', revision: 8, pointIds: ['point-a'] },
      { id: 'other-delete', kind: 'delete', revision: 8, pointIds: ['point-c'] },
    ],
  }));
  assert.equal(unrelated.status, 'pending');
});

test('existing explicit split descendants may share an utterance without blocking an unrelated pickup', () => {
  const snapshot = {
    revision: 7,
    clips: [
      clip('left', 'original', 0, 1, 'point-a', { parentClipId: 'whole', utteranceIds: ['utterance-whole'] }),
      clip('right', 'original', 1, 2, 'point-a', { parentClipId: 'whole', utteranceIds: ['utterance-whole'] }),
    ],
  };
  const result = buildPickupProposal(input({
    proposalId: 'proposal-after-split',
    snapshot,
    sources: [source('original'), source('pickup')],
    intents: [intent('new', 'original', 4, 5, 'point-b', { utteranceIds: ['utterance-new'] })],
  }));
  assert.equal(result.status, 'pending');
  assert.equal(result.conflicts.some(item => item.kind === 'duplicate-utterance'), false);
});

test('a source-local utterance already in the timeline cannot be duplicated at a separate range', () => {
  const snapshot = {
    revision: 7,
    clips: [clip('existing-whole', 'pickup', 4, 5, 'point-a', { utteranceIds: ['utterance-shared'] })],
  };
  const result = buildPickupProposal(input({
    proposalId: 'proposal-duplicate-source-utterance',
    snapshot,
    intents: [intent('duplicate', 'pickup', 0, 1, 'point-b', { utteranceIds: ['utterance-shared'] })],
  }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.some(item => item.kind === 'duplicate-utterance'));
  assert.equal(result.conflicts.find(item => item.kind === 'duplicate-utterance').recovery, 'review-duplicate');
});

test('an excluded existing range is never silently restored by a pickup proposal', () => {
  const snapshot = {
    revision: 7,
    clips: [clip('old-excluded', 'pickup', 0, 1, 'point-b', { included: false, reasonIds: ['creator-delete'], utteranceIds: ['utterance-b'] })],
  };
  const result = buildPickupProposal(input({ snapshot }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.conflicts.some(item => item.kind === 'manual-delete'));
  assert.deepEqual(snapshot.clips[0].reasonIds, ['creator-delete']);
});

test('a late proposal is reviewable but only explicit acceptance yields a command', () => {
  const snapshot = { revision: 7, clips: [] };
  const result = buildPickupProposal(input({ createdAt: 1000, snapshot }));
  assert.equal(result.status, 'pending');
  assert.equal(result.proposal.status, 'pending');
  assert.deepEqual(snapshot.clips, []);
  const stale = acceptPickupProposal({ snapshot: { revision: 8, clips: [] }, proposal: result.proposal, sources: input().sources, currentScope: scope().current });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.conflicts[0].kind, 'stale-edit');
  const accepted = acceptPickupProposal({ snapshot, proposal: result.proposal, commandId: 'creator-acceptance', sources: input().sources, currentScope: scope().current });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.command.id, 'creator-acceptance');
  assert.deepEqual(snapshot.clips, []);
});

test('explicit acceptance rechecks a live scope before handing the action to the engine', () => {
  const result = buildPickupProposal(input({ proposalId: 'proposal-live-scope' }));
  const staleScope = scope({ current: { transcriptRevision: 10 } });
  const accepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: result.proposal, sources: input().sources, currentScope: staleScope.current });
  assert.equal(accepted.status, 'conflict');
  assert.equal(accepted.conflicts[0].kind, 'stale-transcript');
  assert.equal(accepted.command, undefined);
});

test('acceptance reruns snapshot and candidate overlap checks after analysis', () => {
  const snapshot = { revision: 7, clips: [] };
  const built = buildPickupProposal(input({ proposalId: 'proposal-recheck-overlap', snapshot }));
  snapshot.clips.push(clip('arrived-late', 'pickup', 0.5, 1.5, 'point-c', { utteranceIds: ['utterance-late'] }));
  const accepted = acceptPickupProposal({ snapshot, proposal: built.proposal, sources: input().sources, currentScope: scope().current });
  assert.equal(accepted.status, 'conflict');
  assert.ok(accepted.conflicts.some(item => item.kind === 'overlapping-utterance'));
  assert.equal(accepted.command, undefined);

  const candidateMutation = buildPickupProposal(input({ proposalId: 'proposal-recheck-candidate' }));
  candidateMutation.proposal.clips.push({
    ...candidateMutation.proposal.clips[0],
    id: 'clip-overlap',
    t0: 0.5,
    t1: 1.5,
    pointIds: ['point-c'],
    spanIds: ['span-c'],
    utteranceIds: ['utterance-c'],
  });
  const candidateAccepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: candidateMutation.proposal, sources: input().sources, currentScope: scope().current });
  assert.equal(candidateAccepted.status, 'conflict');
  assert.ok(candidateAccepted.conflicts.some(item => item.kind === 'overlapping-utterance'));
  assert.equal(candidateAccepted.command, undefined);
});

test('acceptance rejects a candidate whose stable identities were changed in review data', () => {
  const built = buildPickupProposal(input({ proposalId: 'proposal-recheck-identity' }));
  built.proposal.clips[0].pointIds = ['point-c'];
  const accepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: built.proposal, sources: input().sources, currentScope: scope().current });
  assert.equal(accepted.status, 'conflict');
  assert.ok(accepted.conflicts.some(item => item.kind === 'invalid-intent'));
  assert.equal(accepted.command, undefined);
});

test('acceptance reports malformed reviewed clip data instead of throwing', () => {
  const built = buildPickupProposal(input({ proposalId: 'proposal-malformed-clip' }));
  delete built.proposal.clips[0].reasonIds;
  const accepted = acceptPickupProposal({ snapshot: input().snapshot, proposal: built.proposal, sources: input().sources, currentScope: scope().current });
  assert.equal(accepted.status, 'conflict');
  assert.ok(accepted.conflicts.some(item => item.kind === 'invalid-intent'));
  assert.equal(accepted.command, undefined);
});

test('acceptance refuses to bypass the current media and scope checks', () => {
  const result = buildPickupProposal(input({ proposalId: 'proposal-required-context' }));
  const missing = acceptPickupProposal({ snapshot: input().snapshot, proposal: result.proposal });
  assert.equal(missing.status, 'conflict');
  assert.equal(missing.conflicts[0].kind, 'invalid-intent');
  assert.equal(missing.conflicts[0].recovery, 'retry-with-current-scope');
});
