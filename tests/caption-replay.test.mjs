import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { captionState, reduceCaption } from '../src/lib/live-caption-state.ts';

test('synthetic caption replay is deterministic and preserves utterance timing', () => {
  const f = JSON.parse(readFileSync(new URL('../tools/fixtures/captions.json', import.meta.url), 'utf8'));
  const replay = () => f.events.reduce(reduceCaption, captionState(f.sessionId));
  assert.deepEqual(replay(), replay());
  assert.equal(replay().text, 'This is another sentence.');
  assert.equal(replay().segments[0].t0, 3.1);
  assert.equal(replay().isFinal, false);
});
