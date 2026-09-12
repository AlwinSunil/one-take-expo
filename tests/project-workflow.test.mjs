import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceWithRefined } from '../src/lib/project-workflow.ts';

test('cross-job segmentation cannot overwrite a manually corrected interval', () => {
  const project = { id: 'p', mode: 'assisted', videoUri: 'file:///p.mp4', clips: [], createdAt: 1,
    transcript: [{ id: 'old', t0: 1, t1: 3, text: 'wrong', manualCorrection: 'My correction' }] };
  const result = replaceWithRefined(project, [{ id: 'different-id', t0: 0.9, t1: 3.2, text: 'new output' }, { id: 'other', t0: 4, t1: 5, text: 'next' }]);
  assert.deepEqual(result.transcript, project.transcript);
  assert.deepEqual(result.refinementCandidate, [
    { id: 'different-id', t0: 0.9, t1: 3.2, text: 'new output' },
    { id: 'other', t0: 4, t1: 5, text: 'next' },
  ]);
  assert.equal(result.rawTranscript, undefined);
  assert.equal(result.reviewDecisions, undefined);
});

test('a review annotation retains the entire current timeline and current decisions', () => {
  const decisions = [{ id: 'take:line', type: 'take-selection', lineId: 'line', takeId: 'take' }];
  const transcript = [
    { id: 'edited', t0: 1, t1: 2, text: 'raw edited', manualCorrection: 'creator text' },
    { id: 'marked', t0: 3, t1: 4, text: 'listen here', needsListening: true },
  ];
  const project = { id: 'p', mode: 'assisted', videoUri: 'file:///p.mp4', clips: [], createdAt: 1,
    transcript, reviewDecisions: decisions, rawTranscript: [{ ...transcript[0] }] };
  const result = replaceWithRefined(project, [
    { id: 'new-1', t0: 0, t1: 1, text: 'replacement one', isFinal: true },
    { id: 'new-2', t0: 3, t1: 4, text: 'replacement two', isFinal: true },
  ]);

  assert.deepEqual(result.transcript, transcript);
  assert.deepEqual(result.reviewDecisions, decisions);
  assert.deepEqual(result.rawTranscript, project.rawTranscript);
  assert.deepEqual(result.refinementCandidate, [
    { id: 'new-1', t0: 0, t1: 1, text: 'replacement one', isFinal: true },
    { id: 'new-2', t0: 3, t1: 4, text: 'replacement two', isFinal: true },
  ]);
});

test('an empty refinement keeps usable captions and stores the empty candidate', () => {
  const project = { id: 'p', mode: 'assisted', videoUri: 'file:///p.mp4', clips: [], createdAt: 1,
    captionRevision: 4, reviewDecisions: [], transcript: [{ id: 'live', t0: 1, t1: 2, text: 'usable live caption' }] };
  const result = replaceWithRefined(project, []);

  assert.deepEqual(result.transcript, project.transcript);
  assert.deepEqual(result.refinementCandidate, []);
  assert.equal(result.captionRevision, project.captionRevision);
  assert.deepEqual(result.reviewDecisions, project.reviewDecisions);
});

test('a valid unannotated refinement replaces the current timeline and preserves history', () => {
  const decisions = [{ id: 'take:old', type: 'take-selection', lineId: 'old', takeId: 'old-take' }];
  const project = { id: 'p', mode: 'assisted', videoUri: 'file:///p.mp4', clips: [], createdAt: 1,
    captionRevision: 2, reviewDecisions: decisions,
    transcript: [{ id: 'live', t0: 1, t1: 2, text: 'live caption', isFinal: true }] };
  const candidate = [{ id: 'native-1', t0: 1.1, t1: 2.1, text: 'refined caption', isFinal: true }];
  const result = replaceWithRefined(project, candidate);

  assert.deepEqual(result.transcript, [{ ...candidate[0], id: 'p:refined:0', revision: 3, timingSource: 'saved-audio', source: 'refined' }]);
  assert.deepEqual(result.rawTranscript, project.transcript);
  assert.deepEqual(result.refinementCandidate, candidate);
  assert.deepEqual(result.previousReviewDecisions, decisions);
  assert.deepEqual(result.reviewDecisions, []);
  assert.equal(result.cutsReviewed, false);
  assert.equal(result.captionRevision, 3);
});

test('malformed refinement payloads are rejected before project state changes', () => {
  const project = { id: 'p', mode: 'assisted', videoUri: 'file:///p.mp4', clips: [], createdAt: 1,
    transcript: [{ id: 'live', t0: 1, t1: 2, text: 'live caption' }] };
  assert.throws(() => replaceWithRefined(project, null), /array/);
  assert.throws(() => replaceWithRefined(project, [{ t0: Number.NaN, t1: 2, text: 'bad' }]), /finite/);
  assert.throws(() => replaceWithRefined(project, [{ t0: 1, t1: 1, text: 'bad' }]), /positive/);
  assert.throws(() => replaceWithRefined(project, [{ t0: 1, t1: 2, text: '' }]), /non-empty string/);
  assert.throws(() => replaceWithRefined(project, [{ t0: 1, t1: 2, text: 'bad', isFinal: 'yes' }]), /isFinal/);
});
