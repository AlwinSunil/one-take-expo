import test from 'node:test';
import assert from 'node:assert/strict';
import { visualSuggestionSummary, visualAdvice } from '../src/features/vision/live-advice.ts';
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
test('hints wait two seconds and remain readable for at least four and a half seconds', () => {
 let state = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 1000);
 state = advanceVisualAdvice(state, bright, true, 2999);
 assert.equal(state.current, null);
 state = advanceVisualAdvice(state, bright, true, 3000);
 assert.equal(state.current, 'bright');
 const recovered = { ...bright, exposure: frame.exposure };
 state = advanceVisualAdvice(state, recovered, true, 3100);
 state = advanceVisualAdvice(state, recovered, true, 7499);
 assert.equal(state.current, 'bright');
 state = advanceVisualAdvice(state, recovered, true, 7500);
 assert.equal(state.current, null);
});
test('a different warning cannot interrupt the current hint before its reading time', () => {
 let state = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 0);
 state = advanceVisualAdvice(state, bright, true, 2000);
 const dark = { ...bright, exposure: { mean: 0.1, clipped: 0, dark: 0.9 } };
 state = advanceVisualAdvice(state, dark, true, 2100);
 state = advanceVisualAdvice(state, dark, true, 4100);
 assert.equal(state.current, 'bright');
 state = advanceVisualAdvice(state, dark, true, 6500);
 assert.equal(state.current, 'dark');
});
test('brief tracking jitter holds advice, but stale streams and changed cameras clear it', () => {
 const candidate = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 0);
 assert.equal(advanceVisualAdvice(candidate, { ...bright, exposure: frame.exposure }, true, 2500).current, null);
 const shown = advanceVisualAdvice(candidate, bright, true, 2500);
 assert.equal(shown.current, 'bright');
 assert.equal(advanceVisualAdvice(shown, { ...bright, faceStable: false }, true, 2600).current, 'bright');
 assert.equal(advanceVisualAdvice(shown, bright, false, 2600).current, null);
 assert.equal(advanceVisualAdvice(shown, { ...bright, status: 'stale' }, true, 2600).current, null);
 assert.equal(advanceVisualAdvice(shown, { ...bright, sessionId: 'two' }, true, 2600).current, null);
});
test('invalid exposure measurements cannot generate a lighting warning', () => {
 assert.equal(visualAdvice({ ...frame, exposure: { mean: NaN, clipped: 0.9, dark: 0 } }), null);
 assert.equal(visualAdvice({ ...frame, exposure: { mean: 0.8, clipped: 0.9, dark: 0.9 } }), null);
});

test('release suggestions show current measured checks instead of a build restriction', () => {
  assert.match(visualSuggestionSummary(frame, null), /Watching lighting and framing/);
  assert.match(visualSuggestionSummary({ ...frame, exposure: { mean: 0.8, clipped: 0.3, dark: 0 } }, null), /Watching lighting and framing/);
  assert.match(visualSuggestionSummary({ ...frame, exposure: undefined }, null), /Watching lighting and framing/);
  assert.match(visualSuggestionSummary({ ...frame, exposure: { mean: 2, clipped: 0, dark: 0 } }, null), /Watching lighting and framing/);
  assert.match(visualSuggestionSummary({ ...frame, status: 'pending' }, 'Old hint'), /Watching lighting and framing/);
  assert.match(visualSuggestionSummary({ ...frame, status: 'unavailable' }, 'Old hint'), /Reopen the camera/);
});

test('the panel displays only the settled suggestion, not a new raw-frame warning', () => {
 assert.equal(visualSuggestionSummary(bright, 'Take a moment to adjust the light.'), 'Take a moment to adjust the light.');
 assert.doesNotMatch(visualSuggestionSummary(bright, null), /Harsh/);
});

test('short frame gaps cannot reset reading time or flash an unavailable panel', () => {
 let state = advanceVisualAdvice(emptyVisualAdvice(), bright, true, 0);
 state = advanceVisualAdvice(state, bright, true, 2000);
 const stale = { status: 'unavailable', reason: 'stale-frame', sessionId: bright.sessionId, lensFacing: bright.lensFacing };
 state = advanceVisualAdvice(state, stale, true, 2600);
 assert.equal(state.current, 'bright');
 assert.equal(state.shownAt, 2000);
 assert.equal(visualSuggestionSummary(stale, 'Harsh light on your face.'), 'Harsh light on your face.');
 assert.equal(visualSuggestionSummary(stale, null), visualSuggestionSummary(frame, null));
 state = advanceVisualAdvice(state, bright, true, 2900);
 assert.equal(state.shownAt, 2000);
 assert.equal(advanceVisualAdvice(state, stale, true, 4900).current, null);
 assert.equal(advanceVisualAdvice(state, { ...stale, sessionId: 'other' }, true, 3000).current, null);
 assert.equal(advanceVisualAdvice(state, { ...stale, reason: 'model-error' }, true, 3000).current, null);
});
