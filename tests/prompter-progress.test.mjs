import test from 'node:test';
import assert from 'node:assert/strict';
import { followScript, prompterWords } from '../src/lib/prompter-progress.ts';

const script = prompterWords('Hello, everyone. Today we make something great. Keep it simple.');
test('follows partial speech across script paragraphs with punctuation', () => {
  const result = followScript(script, 'hello everyone today we make');
  assert.equal(result.cursor, 5);
  assert.deepEqual([...result.matched], [0, 1, 2, 3, 4]);
});
test('ignores fillers and requires two words before skipping ahead', () => {
  assert.equal(followScript(script, 'um hello everyone uh today').cursor, 3);
  assert.equal(followScript(script, 'great').cursor, 0);
  const result = followScript(script, 'hello everyone make something');
  assert.equal(result.cursor, 6);
  assert.equal(result.matched.has(2), false);
  assert.equal(result.matched.has(3), false);
});
test('revised recognition and a new take do not retain old highlights', () => {
  assert.equal(followScript(script, 'hello everyone today').cursor, 3);
  assert.equal(followScript(script, 'hello everyone tomorrow').cursor, 2);
  assert.equal(followScript(script, '').cursor, 0);
});
test('repeated words advance once per spoken occurrence', () => {
  assert.equal(followScript(prompterWords('Go go go now'), 'go go').cursor, 2);
});
test('normalizes Unicode and handles empty scripts', () => {
  assert.equal(followScript(prompterWords('Héllo 世界'), 'héllo 世界').cursor, 2);
  assert.equal(followScript([], 'hello').cursor, 0);
});
