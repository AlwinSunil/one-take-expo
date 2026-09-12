import assert from 'node:assert/strict';
import test from 'node:test';
import { captionState, reduceCaption } from '../src/lib/live-caption-state.ts';

test('a previous recording cannot overwrite the new recording captions', () => {
  const state = captionState('new');
  assert.equal(reduceCaption(state, { sessionId: 'old', sequence: 99, text: 'old words', isFinal: true }), state);
});

test('partial revisions replace text and older revisions cannot undo final output', () => {
  const partial = reduceCaption(captionState('one'), { sessionId: 'one', sequence: 1, text: 'hello', isFinal: false });
  const final = reduceCaption(partial, { sessionId: 'one', sequence: 3, text: 'hello world', isFinal: true });
  assert.equal(final.text, 'hello world');
  assert.equal(final.isFinal, true);
  assert.equal(reduceCaption(final, { sessionId: 'one', sequence: 2, text: 'hello word', isFinal: false }), final);
});

test('a new utterance can follow a completed utterance within the same recording', () => {
  const completed = { sessionId: 'one', sequence: 3, text: 'First sentence.', isFinal: true };
  const next = { sessionId: 'one', sequence: 4, text: 'Another sentence', isFinal: false };
  assert.equal(reduceCaption(completed, next), next);
});

test('starting another recording clears prior text and sequence', () => {
  assert.deepEqual(captionState('two'), { sessionId: 'two', sequence: -1, text: '', isFinal: false });
});
