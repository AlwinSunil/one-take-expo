import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePickupRecording, normalizeProject, preserveNewRecordings, PENDING_PICKUP_MESSAGE } from '../src/lib/project-data.ts';

const project = { id: 'project', mode: 'script', script: 'Hello.', videoUri: 'file:///primary.mp4', duration: 10,
  createdAt: 10, clips: [], transcript: [{ id: 'speech', t0: 1, t1: 3, text: 'Hello.', isFinal: true }], trim: { start: 0, end: 8 } };
const input = { videoUri: 'file:///pickup.mp4', duration: 6, transcript: [{ id: 'speech', t0: 1, t1: 3, text: 'Hello.', isFinal: true }],
  takes: [{ id: 'take', t0: 0.5, t1: 4, mediaUri: 'file:///pickup.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['speech'] }] };

test('pickup preserves legacy original, captions and trim while namespacing collisions', () => {
  const merged = mergePickupRecording(project, 'pickup-1', input, 20);
  assert.equal(merged.videoUri, project.videoUri);
  assert.deepEqual(merged.trim, project.trim);
  assert.equal(merged.transcript[0].id, 'speech');
  assert.equal(merged.transcript[1].id, 'pickup-1:caption:speech');
  assert.equal(merged.transcript[1].recordingId, 'pickup-1');
  assert.deepEqual(merged.takes[1].transcriptSegmentIds, ['pickup-1:caption:speech']);
  assert.equal(merged.takes[0].mediaUri, project.videoUri);
  assert.equal(merged.takes[1].mediaUri, input.videoUri);
  assert.deepEqual([merged.takes[1].t0, merged.takes[1].t1], [0.5, 4]);
  assert.equal(merged.recordings.length, 2);
  assert.equal(merged.cutsReviewed, false);
});

test('replaying a committed pickup is idempotent', () => {
  const merged = mergePickupRecording(project, 'pickup-1', input, 20);
  assert.deepEqual(mergePickupRecording(merged, 'pickup-1', input, 30), merged);
});

test('pickup rejects foreign source, invalid intervals and dangling evidence', () => {
  assert.throws(() => mergePickupRecording(project, 'p', { ...input, duration: 2 }, 20), /timing/);
  assert.throws(() => mergePickupRecording(project, 'p', { ...input, takes: [{ ...input.takes[0], mediaUri: 'file:///foreign.mp4' }] }, 20), /own recording/);
  assert.throws(() => mergePickupRecording(project, 'p', { ...input, takes: [{ ...input.takes[0], transcriptSegmentIds: ['missing'] }] }, 20), /unknown caption/);
});

test('pickup retains earlier manual decisions and required action state', () => {
  const original = normalizeProject({ ...project, scriptLines: [{ id: 'line', text: 'Hello.', spokenText: 'Hello.', actionCues: [{ id: 'cue', text: 'Smile', required: true, resolved: false }] }],
    reviewDecisions: [{ id: 'decision', type: 'take-selection', lineId: 'line', takeId: 'take:speech' }],
    pickupRequest: { lineIds: ['line'], requestedAt: 1 } });
  const merged = mergePickupRecording(original, 'p', input, 20);
  assert.deepEqual(merged.reviewDecisions, original.reviewDecisions);
  assert.equal(merged.scriptLines[0].actionCues[0].resolved, false);
  assert.equal(merged.pickupRequest, undefined);
});

test('corrupt recording or review source metadata is rejected without dropping originals', () => {
  assert.throws(() => normalizeProject({ ...project, recordings: [{ id: 'r', mediaUri: '', duration: 1, createdAt: 1 }] }), /recordings/);
  assert.throws(() => normalizeProject({ ...project, reviewSegments: [{ uri: 'file:///primary.mp4', t0: 3, t1: 1 }] }), /review segments/);
});


test('an older editor snapshot cannot overwrite a concurrently attached pickup', () => {
  const current = mergePickupRecording(project, 'pickup-1', input, 20);
  const edit = { ...project, trim: { start: 2, end: 7 } };
  const saved = preserveNewRecordings(current, edit);
  assert.deepEqual(saved.trim, edit.trim);
  assert.equal(saved.recordings.length, 2);
  assert.equal(saved.transcript.length, 2);
  assert.equal(saved.takes.length, 2);
  assert.equal(saved.transcript[1].recordingId, 'pickup-1');
  assert.equal(saved.cutsReviewed, false);
});

test('a pickup can only replace requested lines while its whole take remains intact', async () => {
  const { projectReview } = await import('../src/lib/project-workflow.ts');
  const { cleanReview } = await import('../src/lib/clean-review.ts');
  const original = { ...project, script: 'Hello. Goodbye.', transcript: [{ id: 'old', t0: 0, t1: 2, text: 'Hello.', isFinal: true }] };
  const pickup = { ...input, transcript: [{ id: 'speech', t0: 1, t1: 3, text: 'Hello. Goodbye.', isFinal: true }], eligibleLineIds: ['project:line:1'] };
  const merged = mergePickupRecording(original, 'pickup-1', pickup, 30);
  for (const review of [projectReview(merged), cleanReview(merged)]) {
    assert.equal(review.lines[0].selectedTakeId, 'take:old');
    assert.deepEqual(review.lines[0].candidateTakeIds, ['take:old']);
    assert.equal(review.lines[1].selectedTakeId, 'pickup-1:take:take');
    assert.equal(review.takes.length, 2);
    assert.deepEqual([review.takes[1].t0, review.takes[1].t1], [0.5, 4]);
  }
});

test('a raw checkpoint survives while the same recording gains final evidence exactly once', async () => {
  const { projectReview } = await import('../src/lib/project-workflow.ts');
  const pending = mergePickupRecording(project, 'checkpoint', { videoUri: input.videoUri, duration: input.duration, transcript: [], takes: [], evidenceStatus: 'pending' }, 20);
  assert.equal(pending.recordings[1].evidenceStatus, 'pending');
  assert.equal(pending.transcript.length, project.transcript.length);
  assert.throws(() => mergePickupRecording(pending, 'checkpoint', { ...input, evidenceStatus: 'pending' }, 21), /cannot claim/);
  const complete = mergePickupRecording(pending, 'checkpoint', { ...input, evidenceStatus: 'complete' }, 22);
  assert.equal(complete.recordings.length, 2);
  assert.equal(complete.recordings[1].evidenceStatus, 'complete');
  assert.equal(complete.recordings[1].mediaUri, pending.recordings[1].mediaUri);
  assert.equal(complete.recordings[1].createdAt, 20);
  assert.equal(complete.transcript.length, 2);
  assert.deepEqual(mergePickupRecording(complete, 'checkpoint', input, 30), complete);
  assert.equal(projectReview({ ...complete, recordings: pending.recordings }).takes[1].playable, false);
});

test('finalizing a checkpoint preserves later recordings and survives an older editor save', () => {
  const pending = mergePickupRecording(project, 'checkpoint', { videoUri: input.videoUri, duration: 6, transcript: [], takes: [], evidenceStatus: 'pending' }, 20);
  const later = mergePickupRecording(pending, 'later', { ...input, videoUri: 'file:///later.mp4', takes: input.takes.map(take => ({ ...take, mediaUri: 'file:///later.mp4' })) }, 30);
  const complete = mergePickupRecording(later, 'checkpoint', input, 20);
  assert.equal(complete.recordings.length, 3);
  assert.equal(complete.transcript.length, 3);
  const stale = preserveNewRecordings(complete, { ...pending, trim: { start: 2, end: 8 } });
  assert.equal(stale.recordings.find(recording => recording.id === 'checkpoint').evidenceStatus, 'complete');
  assert.equal(stale.recordings.length, 3);
  assert.equal(stale.transcript.length, 3);
  assert.deepEqual(stale.trim, { start: 2, end: 8 });
  assert.throws(() => mergePickupRecording(pending, 'checkpoint', { ...input, videoUri: 'file:///unrelated.mp4' }, 20), /different recording/);
});


test('checkpoint preserves the requested subset and finalization clears only its own recovery warning', () => {
  const requested = { ...project, pickupRequest: { lineIds: ['project:line:0'], requestedAt: 15 } };
  const pending = mergePickupRecording(requested, 'checkpoint', { videoUri: input.videoUri, duration: 6, transcript: [], takes: [], evidenceStatus: 'pending' }, 20);
  assert.deepEqual(pending.pickupRequest, requested.pickupRequest);
  const complete = mergePickupRecording({ ...pending, recoveryMessage: PENDING_PICKUP_MESSAGE }, 'checkpoint', input, 20);
  assert.equal(complete.recoveryMessage, undefined);
  assert.equal(complete.pickupRequest, undefined);
  assert.equal(preserveNewRecordings(complete, { ...pending, recoveryMessage: PENDING_PICKUP_MESSAGE }).recoveryMessage, undefined);
  const unrelated = mergePickupRecording({ ...pending, recoveryMessage: 'Another source is missing.' }, 'checkpoint', input, 20);
  assert.equal(unrelated.recoveryMessage, 'Another source is missing.');
});


test('reused pickup identity validates the complete duplicate payload', () => {
  const merged = mergePickupRecording(project, 'p', input, 20);
  assert.throws(() => mergePickupRecording(merged, 'p', { ...input, duration: 7 }, 30), /different/);
  assert.throws(() => mergePickupRecording(merged, 'p', { ...input, videoUri: 'file:///foreign.mp4' }, 30), /different recording/);
  assert.throws(() => mergePickupRecording(merged, 'p', { ...input, transcript: [{ ...input.transcript[0], text: 'Changed' }] }, 30), /different payload/);
});
