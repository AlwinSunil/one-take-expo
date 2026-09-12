import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePickupRecording, normalizeProject, preserveNewRecordings } from '../src/lib/project-data.ts';

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
