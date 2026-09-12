import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReview, selectedReviewCuts, selectedReviewSegments, pickupLineIds } from '../src/lib/clean-review.ts';
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

test('pickup source timestamps stay local while recording recency chooses replacement', () => {
  const p = project([seg('old', 'Hello world.', 20), seg('bye', 'Goodbye world.', 30), seg('pickup', 'Hello world.', 0)], {
    recordings: [{ id: 'raw', mediaUri: 'file:///raw.mp4', duration: 40, createdAt: 1 }, { id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 3, createdAt: 2 }],
    takes: [
      { id: 'old', t0: 20, t1: 22, mediaUri: 'file:///raw.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['old'] },
      { id: 'bye', t0: 30, t1: 32, mediaUri: 'file:///raw.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['bye'] },
      { id: 'pickup', t0: 0, t1: 2, mediaUri: 'file:///pickup.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['pickup'] },
    ],
  });
  const result = selectedReviewSegments(p);
  assert.deepEqual(result.segments.map(s => [s.takeId, s.uri, s.t0]), [['pickup', 'file:///pickup.mp4', 0], ['bye', 'file:///raw.mp4', 30]]);
  assert.deepEqual(result.segments[0].captions, [{ t0: 0, t1: 2, text: 'Hello world.' }]);
  const missing = selectedReviewSegments({ ...p, unavailableTakeIds: ['pickup'] });
  assert.equal(missing.segments[0].takeId, 'old');
});
test('prepared multi-source selections preserve whole takes and reject duration overrun', () => {
  const p = project([seg('both', 'Hello world. Goodbye world.', 0)], { duration: 1 });
  const result = selectedReviewSegments(p);
  assert.deepEqual(result.segments, []);
  assert.deepEqual(result.unavailableTakeIds, ['take:both']);
});

test('pickup matching an unrequested line cannot replace its existing take', () => {
  const p = project([seg('old', 'Goodbye world.', 10), seg('pickup', 'Goodbye world.', 0)], {
    takes: [
      { id: 'old', t0: 10, t1: 12, mediaUri: 'file:///raw.mp4', playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['old'], recordedAt: 1 },
      { id: 'pickup', t0: 0, t1: 2, mediaUri: 'file:///pickup.mp4', playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['pickup'], recordedAt: 2, eligibleLineIds: ['p:line:0'] },
    ],
  });
  const review = cleanReview(p);
  assert.equal(review.lines[1].selectedTakeId, 'old');
  assert.deepEqual(review.lines[1].candidateTakeIds, ['old']);
});

test('pickup eligibility never hides repeated words inside a whole take', () => {
  const p = project([seg('old', 'Goodbye world.', 10), seg('pickup', 'Hello world. Goodbye world.', 0)], {
    takes: [
      { id: 'old', t0: 10, t1: 12, mediaUri: 'file:///raw.mp4', playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['old'], recordedAt: 1 },
      { id: 'pickup', t0: 0, t1: 2, mediaUri: 'file:///pickup.mp4', playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['pickup'], recordedAt: 2, eligibleLineIds: ['p:line:0'] },
    ],
  });
  assert.deepEqual(selectedReviewSegments(p).segments, []);
  assert.deepEqual(selectedReviewSegments(p).conflicts, ['pickup']);
});
