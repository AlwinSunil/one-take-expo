import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCaptureCommandGate,
  nativeCommandForKeyCode,
} from '../src/features/capture/capture-controls.ts';

test('native volume and camera keys map to capture commands without claiming a remote', () => {
  assert.equal(nativeCommandForKeyCode(24), 'advance');
  assert.equal(nativeCommandForKeyCode(25), 'scratch');
  assert.equal(nativeCommandForKeyCode(27), 'advance');
  assert.equal(nativeCommandForKeyCode(85), 'advance');
  assert.equal(nativeCommandForKeyCode(4), null);
});

test('commands are ignored while capture is inactive and after it ends', () => {
  const gate = createCaptureCommandGate();

  assert.deepEqual(gate.receive({ command: 'advance', source: 'tap' }), {
    accepted: false,
    reason: 'inactive',
  });

  gate.begin('take-1');
  assert.equal(gate.receive({ command: 'advance', source: 'tap' }).accepted, true);
  gate.end();
  assert.deepEqual(gate.receive({ command: 'scratch', source: 'native-key', eventId: 1, generation: 1 }), {
    accepted: false,
    reason: 'inactive',
  });
});

test('one native key event is emitted once, while distinct presses remain usable', () => {
  const gate = createCaptureCommandGate();
  const generation = gate.begin('take-2');

  const first = gate.receive({ command: 'advance', source: 'native-key', eventId: 7, generation });
  assert.deepEqual(first, {
    accepted: true,
    command: 'advance',
    source: 'native-key',
    takeId: 'take-2',
    generation,
  });
  assert.deepEqual(gate.receive({ command: 'advance', source: 'native-key', eventId: 7, generation }), {
    accepted: false,
    reason: 'duplicate-event',
  });
  assert.equal(gate.receive({ command: 'advance', source: 'native-key', eventId: 8, generation }).accepted, true);
});

test('a queued event from a previous take cannot affect the next take', () => {
  const gate = createCaptureCommandGate();
  const firstGeneration = gate.begin('take-1');
  gate.end();
  const secondGeneration = gate.begin('take-2');

  assert.notEqual(secondGeneration, firstGeneration);
  assert.deepEqual(gate.receive({ command: 'scratch', source: 'native-key', eventId: 9, generation: firstGeneration }), {
    accepted: false,
    reason: 'stale-event',
  });
  const accepted = gate.receive({ command: 'scratch', source: 'native-key', eventId: 10, generation: secondGeneration });
  assert.equal(accepted.accepted, true);
  if (accepted.accepted) assert.equal(accepted.takeId, 'take-2');
});
