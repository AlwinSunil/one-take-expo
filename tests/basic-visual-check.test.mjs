import test from 'node:test';
import assert from 'node:assert/strict';
import { basicVisualCheck } from '../src/features/vision/basic-check.ts';

const input = { status: 'ready', sessionId: 'one', lensFacing: 'front', engine: 'mlkit-face', processor: 'cpu-fallback', frameCapturedAtMs: 1000, facePresence: 'present', faceStable: true, faces: [{ left: .3, top: .2, right: .7, bottom: .8 }] };
test('tap describes real face count and approximate frame margin without quality claims', () => {
  assert.match(basicVisualCheck(input, 1200).message, /One face detected with space/);
  assert.match(basicVisualCheck({ ...input, faces: [{ ...input.faces[0], top: .01 }] }, 1200).message, /close to an edge/);
  assert.match(basicVisualCheck({ ...input, faces: [...input.faces, ...input.faces] }, 1200).message, /2 faces detected/);
  assert.match(basicVisualCheck({ ...input, facePresence: 'absent', faces: [] }, 1200).message, /No face detected/);
});
test('stale, future, unknown and malformed evidence never becomes a positive check', () => {
  for (const now of [999, 1501, NaN]) assert.equal(basicVisualCheck(input, now).status, 'unavailable');
  for (const patch of [{ status: 'pending' }, { status: 'unavailable' }, { facePresence: 'unknown' }, { faces: [] }, { faces: [{ left: NaN, top: 0, right: 1, bottom: 1 }] }]) {
    assert.equal(basicVisualCheck({ ...input, ...patch }, 1200).status, 'unavailable');
  }
});
