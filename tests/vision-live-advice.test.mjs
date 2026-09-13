import test from 'node:test';
import assert from 'node:assert/strict';
import { visualAdvice } from '../src/features/vision/live-advice.ts';
const frame = { status: 'ready', faceStable: true, facePresence: 'present', faces: [{ left: 0.2, right: 0.8, top: 0.2, bottom: 0.8 }], exposure: { mean: 0.5, clipped: 0.02, dark: 0.02 } };
test('visual advice requires stable present-face exposure evidence', () => {
  assert.equal(visualAdvice(frame), null);
  assert.equal(visualAdvice({ ...frame, faceStable: false, exposure: { mean: 1, clipped: 1, dark: 0 } }), null);
  assert.equal(visualAdvice({ ...frame, facePresence: 'unknown', exposure: { mean: 1, clipped: 1, dark: 0 } }), null);
  assert.match(visualAdvice({ ...frame, exposure: { mean: 0.8, clipped: 0.3, dark: 0 } }), /Harsh light/);
  assert.match(visualAdvice({ ...frame, exposure: { mean: 0.1, clipped: 0, dark: 0.8 } }), /too dark/);
  assert.match(visualAdvice({ ...frame, facePresence: 'absent', faces: [] }), /out of view/);
});
test('framing advice follows the main face instead of a smaller bystander', () => {
  assert.equal(visualAdvice({ ...frame, faces: [{ left: 0, right: 0.1, top: 0, bottom: 0.1 }, ...frame.faces] }), null);
  assert.match(visualAdvice({ ...frame, faces: [{ left: 0, right: 0.8, top: 0.2, bottom: 0.8 }] }), /Move back/);
});

import { advanceVisualAdvice, emptyVisualAdvice } from '../src/features/vision/live-advice.ts';
const bright = { ...frame, sessionId: 'one', lensFacing: 'front', exposure: { mean: 0.8, clipped: 0.3, dark: 0 } };
test('advice requires sustained evidence, holds across threshold jitter, and clears after recovery', () => {
 let state = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 1000);
 state = advanceVisualAdvice(state, bright, true, 2399);
 assert.equal(state.current, null);
 state = advanceVisualAdvice(state, bright, true, 2400);
 assert.equal(state.current, 'bright');
 state = advanceVisualAdvice(state, { ...bright, exposure: { mean: 0.7, clipped: 0.14, dark: 0 } }, true, 2500);
 assert.equal(state.current, 'bright');
 const recovered = { ...bright, exposure: frame.exposure };
 state = advanceVisualAdvice(state, recovered, true, 2600);
 assert.equal(state.current, 'bright');
 state = advanceVisualAdvice(state, recovered, true, 3300);
 assert.equal(state.current, null);
});
test('a single bad frame, stale stream, disabled coach, and new camera session cannot retain advice', () => {
 const candidate = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 0);
 assert.equal(advanceVisualAdvice(candidate, { ...bright, exposure: frame.exposure }, true, 1500).current, null);
 const shown = advanceVisualAdvice(candidate, bright, true, 1500);
 assert.equal(shown.current, 'bright');
 assert.equal(advanceVisualAdvice(shown, bright, false, 1600).current, null);
 assert.equal(advanceVisualAdvice(shown, { ...bright, status: 'stale' }, true, 1600).current, null);
 assert.equal(advanceVisualAdvice(shown, { ...bright, sessionId: 'two' }, true, 1600).current, null);
});
test('invalid exposure measurements cannot generate a lighting warning', () => {
 assert.equal(visualAdvice({ ...frame, exposure: { mean: NaN, clipped: 0.9, dark: 0 } }), null);
 assert.equal(visualAdvice({ ...frame, exposure: { mean: 0.8, clipped: 0.9, dark: 0.9 } }), null);
});
