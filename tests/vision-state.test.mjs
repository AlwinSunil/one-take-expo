import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginVisionSession,
  createVisionState,
  markVisionStale,
  reduceVisionEvent,
  toVisionEvidence,
} from '../src/features/vision/state.ts';

function statusEvent(overrides = {}) {
  return {
    type: 'status',
    sessionId: 'take-1',
    lensFacing: 'front',
    status: 'ready',
    engine: 'mlkit-face',
    processor: 'cpu-fallback',
    ...overrides,
  };
}

function frameEvent(overrides = {}) {
  return {
    type: 'frame',
    sessionId: 'take-1',
    lensFacing: 'front',
    frameId: 1,
    frameCapturedAtMs: 1_000,
    facePresent: true,
    stable: true,
    faces: [],
    ...overrides,
  };
}

test('accepts a current-session frame and exposes stable face presence', () => {
  let state = createVisionState();
  state = beginVisionSession(state, 'take-1', 'front');
  state = reduceVisionEvent(state, statusEvent({ status: 'pending' }), 900);
  state = reduceVisionEvent(state, statusEvent(), 950);
  state = reduceVisionEvent(state, frameEvent(), 1_010);

  assert.equal(state.status, 'ready');
  assert.equal(state.sessionId, 'take-1');
  assert.equal(state.lensFacing, 'front');
  assert.equal(state.facePresence, 'present');
  assert.equal(state.faceStable, true);
  assert.equal(state.lastFrameCapturedAtMs, 1_000);
  assert.equal(state.engine, 'mlkit-face');
  assert.equal(state.processor, 'cpu-fallback');
});

test('ignores late frames from a previous session or lens', () => {
  let state = createVisionState();
  state = beginVisionSession(state, 'take-1', 'front');
  state = reduceVisionEvent(state, statusEvent(), 100);
  state = reduceVisionEvent(state, frameEvent({ frameCapturedAtMs: 200 }), 210);
  state = beginVisionSession(state, 'take-2', 'back');
  state = reduceVisionEvent(state, statusEvent({ sessionId: 'take-2', lensFacing: 'back' }), 300);

  const lateSession = reduceVisionEvent(
    state,
    frameEvent({ sessionId: 'take-1', lensFacing: 'front', frameCapturedAtMs: 250 }),
    310,
  );
  const lateLens = reduceVisionEvent(
    state,
    frameEvent({ sessionId: 'take-2', lensFacing: 'front', frameCapturedAtMs: 350 }),
    360,
  );

  assert.deepEqual(lateSession, state);
  assert.deepEqual(lateLens, state);
});

test('stale frames clear face presence and become unavailable to consumers', () => {
  let state = createVisionState();
  state = beginVisionSession(state, 'take-1', 'front');
  state = reduceVisionEvent(state, statusEvent(), 100);
  state = reduceVisionEvent(state, frameEvent({ frameCapturedAtMs: 200 }), 210);

  const stale = markVisionStale(state, 801);

  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.reason, 'stale-frame');
  assert.equal(stale.facePresence, 'unknown');
  assert.equal(stale.faceStable, false);
  assert.equal(stale.lastFrameCapturedAtMs, null);
  assert.equal(toVisionEvidence(stale, 801).status, 'unavailable');
});

test('preserves the explicit unavailable reason when NPU execution is blocked', () => {
  const state = reduceVisionEvent(
    beginVisionSession(createVisionState(), 'take-1', 'front'),
    statusEvent({
      status: 'unavailable',
      reason: 'runtime-unavailable',
      engine: 'none',
      processor: 'unknown',
    }),
    100,
  );

  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'runtime-unavailable');
  assert.equal(toVisionEvidence(state, 100).reason, 'runtime-unavailable');
});
