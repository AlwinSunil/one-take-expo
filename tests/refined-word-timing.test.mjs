import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichWordTiming, needsRefinedWords } from '../src/lib/refined-word-timing.ts';
import { buildAutomaticEdit } from '../src/lib/automatic-edit.ts';
const word = (text, t0, t1, confidence = 0.95) => ({ text, t0, t1, confidence });
const original = { id: 's', text: 'This um is um useful.', t0: 1, t1: 5, isFinal: true, recordingId: 'pickup', manualCorrection: 'This is useful.' };
test('offline words enrich exact ordered speech without changing identity or manual edits', () => {
  const words = [word('This', 1, 1.3), word('um', 1.4, 1.6), word('is', 2, 2.2), word('um', 3, 3.2), word('useful', 4, 4.8)];
  const [result] = enrichWordTiming([original], [{ words }]);
  assert.deepEqual(result, { ...original, words, wordTimingSource: 'saved-audio' });
  assert.equal(needsRefinedWords([original]), true);
  assert.equal(needsRefinedWords([result]), false);
  const p = { id: 'p', videoUri: 'file:///p.mp4', duration: 6, transcript: [{ ...result, recordingId: undefined, manualCorrection: undefined }] };
  assert.deepEqual(buildAutomaticEdit(p).clips.filter(c => !c.included).map(c => [c.t0, c.t1]), [[1.4, 1.6], [3, 3.2]]);
});
test('unmatched, low confidence and out of bounds words cannot authorize filler cuts', () => {
  const [result] = enrichWordTiming([original], [{ words: [word('um', 0.5, 0.8), word('This', 1, 1.3), word('um', 2, 2.2, 0.5), word('different', 3, 3.5), word('um', 4.9, 5.2)] }]);
  assert.deepEqual(result.words, [word('This', 1, 1.3)]);
  const p = { id: 'p', videoUri: 'file:///p.mp4', duration: 6, transcript: [{ ...result, recordingId: undefined, manualCorrection: undefined }] };
  assert.ok(buildAutomaticEdit(p).clips.every(c => c.included));
});
test('overlapping original utterances cannot consume the same offline word twice', () => {
  const words = [word('um', 2, 2.2)];
  const result = enrichWordTiming([{ ...original, text: 'um' }, { ...original, id: 's2', text: 'um' }], [{ words }]);
  assert.equal(result[0].words.length, 1);
  assert.equal(result[1].words, undefined);
});
test('no offline alignment preserves unmatched original speech', () => {
  assert.equal(enrichWordTiming([original], [{ words: [word('hello', 2, 3)] }])[0], original);
});

test('live confidence scores cannot suppress offline refinement', () => {
  const live = { ...original, timingSource: 'live-estimate', words: [word('um', 3.072, 3.113, 1)] };
  assert.equal(needsRefinedWords([live]), true);
  const [result] = enrichWordTiming([live], [{ words: [word('um', 3.5, 3.8)] }]);
  assert.equal(result.timingSource, 'live-estimate');
  assert.equal(result.wordTimingSource, 'saved-audio');
  assert.deepEqual(result.words, [word('um', 3.5, 3.8)]);
  assert.equal(needsRefinedWords([result]), false);
});
