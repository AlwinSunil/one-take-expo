import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFillerRemovalSnapshot,
  removeFillerFromSegments,
  restoreFillerRemoval,
  timelineFields,
} from '../src/lib/filler-removal.ts';

const segment = (uri, t0, t1, extra = {}) => ({ uri, t0, t1, ...extra });

test('splits one source segment around the selected filler and preserves captions', () => {
  const segments = [segment('file:///one.mp4', 0, 10, {
    takeId: 'take-1',
    captions: [{ t0: 1, t1: 3, text: 'hello um there' }],
  })];
  const result = removeFillerFromSegments(segments, {
    sourceUri: 'file:///one.mp4', sourceStart: 4, sourceEnd: 5, sourceSegmentIndex: 0,
  });
  assert.deepEqual(result, [
    segment('file:///one.mp4', 0, 4, { takeId: 'take-1', captions: [{ t0: 1, t1: 3, text: 'hello um there' }] }),
    segment('file:///one.mp4', 5, 10, { takeId: 'take-1', captions: [] }),
  ]);
});

test('source and occurrence identity prevents deleting the same timestamp in another source', () => {
  const segments = [segment('file:///one.mp4', 0, 5), segment('file:///two.mp4', 0, 5)];
  const result = removeFillerFromSegments(segments, {
    sourceUri: 'file:///two.mp4', sourceStart: 1, sourceEnd: 2, sourceSegmentIndex: 1,
  });
  assert.deepEqual(result.map(({ uri, t0, t1 }) => ({ uri, t0, t1 })), [
    { uri: 'file:///one.mp4', t0: 0, t1: 5 },
    { uri: 'file:///two.mp4', t0: 0, t1: 1 },
    { uri: 'file:///two.mp4', t0: 2, t1: 5 },
  ]);
});

test('removing an entire source range retains the original project media identity', () => {
  const original = {
    id: 'p', mode: 'assisted', videoUri: 'file:///original.mp4', clips: [], transcript: [], createdAt: 1,
    reviewSegments: [segment('file:///original.mp4', 0, 5)], cutsReviewed: true,
  };
  const before = timelineFields(original);
  const afterSegments = removeFillerFromSegments(original.reviewSegments, {
    sourceUri: 'file:///original.mp4', sourceStart: 1, sourceEnd: 4, sourceSegmentIndex: 0,
  });
  const next = { ...original, reviewSegments: afterSegments };
  assert.equal(next.videoUri, original.videoUri);
  assert.deepEqual(next.reviewSegments, [segment('file:///original.mp4', 0, 1), segment('file:///original.mp4', 4, 5)]);
  assert.deepEqual(before.reviewSegments, original.reviewSegments);
});

test('undo restores only the removal timeline and refuses a later timeline edit', () => {
  const before = {
    cuts: undefined,
    reviewSegments: [segment('file:///one.mp4', 0, 10)],
    cutsReviewed: true,
  };
  const after = {
    cuts: undefined,
    reviewSegments: [segment('file:///one.mp4', 0, 4), segment('file:///one.mp4', 5, 10)],
    cutsReviewed: true,
  };
  const snapshot = createFillerRemovalSnapshot(before, after);
  const restored = restoreFillerRemoval({ ...after, captionRevision: 8 }, snapshot);
  assert.deepEqual(restored?.reviewSegments, before.reviewSegments);
  assert.equal(restored?.captionRevision, 8);
  assert.equal(restoreFillerRemoval({ ...after, reviewSegments: [segment('file:///one.mp4', 0, 3), segment('file:///one.mp4', 5, 10)] }, snapshot), null);
});

test('rejects deleting the complete timeline or creating more than one hundred segments', () => {
  assert.throws(() => removeFillerFromSegments([segment('file:///one.mp4', 0, 1)], {
    sourceUri: 'file:///one.mp4', sourceStart: 0, sourceEnd: 1, sourceSegmentIndex: 0,
  }), /at least one/);
  const many = Array.from({ length: 100 }, (_, index) => segment('file:///one.mp4', index, index + 1));
  assert.throws(() => removeFillerFromSegments(many, {
    sourceUri: 'file:///one.mp4', sourceStart: 0.5, sourceEnd: 0.75, sourceSegmentIndex: 0,
  }), /too many/);
});
