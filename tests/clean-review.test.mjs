import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReview, selectedReviewCuts, pickupLineIds } from '../src/lib/clean-review.ts';
const project = (transcript, extra = {}) => ({ id: 'p', mode: 'script', script: 'Hello world. Goodbye world.', videoUri: 'file:///raw.mp4', transcript, clips: [], createdAt: 1, ...extra });
const seg = (id, text, t0, extra = {}) => ({ id, text, t0, t1: t0 + 2, ...extra });
test('latest clean attempts play in script order, excluding scratched and pending', () => {
  const p = project([seg('early', 'Hello world.', 0), seg('bye', 'Goodbye world.', 3), seg('late', 'Hello world.', 6), seg('scratch', 'Hello world.', 9, { needsListening: true }), seg('pending', 'Goodbye world.', 12, { isFinal: false })]);
  assert.deepEqual(selectedReviewCuts(cleanReview(p), p.videoUri).cuts, [{ t0: 6, t1: 8 }, { t0: 3, t1: 5 }]);
});
test('one breath take stays whole and appears once', () => {
  const p = project([seg('both', 'Hello world. Goodbye world.', 0)]);
  assert.deepEqual(selectedReviewCuts(cleanReview(p), p.videoUri).cuts, [{ t0: 0, t1: 2 }]);
});
test('manual selection wins over latest attempt', () => {
  const p = project([seg('early', 'Hello world.', 0), seg('late', 'Hello world.', 4)], { reviewDecisions: [{ id: 'choice', type: 'take-selection', lineId: 'p:line:0', takeId: 'take:early' }] });
  assert.equal(selectedReviewCuts(cleanReview(p), p.videoUri).cuts[0].t0, 0);
  assert.deepEqual(pickupLineIds(cleanReview(p)), ['p:line:1']);
});
test('missing, pending and no-speech recordings never claim a clean cut', () => {
  for (const p of [project([]), project([seg('pending', 'Hello world.', 0, { isFinal: false })]), project([seg('gone', 'Hello world.', 0)], { mediaMissing: true })]) {
    assert.deepEqual(selectedReviewCuts(cleanReview(p), p.videoUri).cuts, []);
    assert.equal(pickupLineIds(cleanReview(p)).length, 2);
  }
});
test('out-of-range and foreign media are reported instead of played', () => {
  const p = project([seg('hello', 'Hello world.', 0)]);
  assert.deepEqual(selectedReviewCuts(cleanReview(p), 'file:///other.mp4').unavailableTakeIds, ['take:hello']);
  assert.deepEqual(selectedReviewCuts(cleanReview(p), p.videoUri, 1).cuts, []);
});
test('conflicting whole-take choices require review instead of repeating a line', () => {
  const p = project([seg('both', 'Hello world. Goodbye world.', 0), seg('bye', 'Goodbye world.', 4)]);
  const result = selectedReviewCuts(cleanReview(p), p.videoUri);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.cuts, []);
});
test('multiple recordings do not pretend source-relative times establish recency', () => {
  const p = project([seg('hello', 'Hello world.', 0)]);
  const review = cleanReview(p);
  review.takes.push({ ...review.takes[0], id: 'foreign', mediaUri: 'file:///pickup.mp4' });
  assert.deepEqual(selectedReviewCuts(review, p.videoUri).cuts, []);
});
