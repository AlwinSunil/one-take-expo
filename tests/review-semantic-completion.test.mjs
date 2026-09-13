import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSourceSemantics } from '../src/lib/review-semantic-completion.ts';
const line = (id, spokenText) => ({ id, spokenText, actionCues: [] });
const seg = (id, text, extra = {}) => ({ id, text, isFinal: true, t0: 0, t1: 3, ...extra });
const base = { id: 'p', videoUri: 'file:///p.mp4', scriptLines: [line('a', 'Welcome to this tutorial.'), line('b', 'Delivery is free.')], transcript: [] };
test('postcapture completion skips lexical completion but recognizes unfinished live paraphrases', async () => {
  const p = { ...base, transcript: [seg('s1', 'Welcome to this tutorial.'), seg('s2', 'There is no shipping charge.', { t0: 4, t1: 7 })] };
  const calls = [];
  const result = await completeSourceSemantics(p, p.videoUri, async (lines, segment) => { calls.push(segment.id); return { segmentId: segment.id, text: segment.text, lineId: 'b', verdict: 'complete' }; }, () => true);
  assert.deepEqual(calls, ['s2']);
  assert.equal(result[0].lineId, 'b');
});
test('pickup inference is scoped to its source and explicitly eligible lines', async () => {
  const p = { ...base, recordings: [{ id: 'r', mediaUri: 'file:///pickup.mp4' }], takes: [{ mediaUri: 'file:///pickup.mp4', eligibleLineIds: ['b'], transcriptSegmentIds: ['pickup'] }], transcript: [seg('primary', 'Something else.'), seg('pickup', 'Shipping costs nothing.', { recordingId: 'r' })] };
  const calls = [];
  await completeSourceSemantics(p, 'file:///pickup.mp4', async (lines, segment) => { calls.push([lines.map(l => l.id), segment.id]); return null; }, () => true);
  assert.deepEqual(calls, [[['b'], 'pickup']]);
});
test('existing exact semantic matches are retained; stale text cannot skip the final pass', async () => {
  const saved = { segmentId: 's', text: 'Old wording.', lineId: 'b', verdict: 'complete' };
  const p = { ...base, transcript: [seg('s', 'Shipping costs nothing.')], semanticMatches: [saved] };
  const result = await completeSourceSemantics(p, p.videoUri, async (_, s) => ({ segmentId: s.id, text: s.text, lineId: 'b', verdict: 'complete' }), () => true);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], saved);
});
test('cancellation discards an in-flight result and prevents further model work', async () => {
  let active = true, count = 0;
  const p = { ...base, transcript: [seg('s', 'Shipping costs nothing.'), seg('t', 'Come and join us.')] };
  const result = await completeSourceSemantics(p, p.videoUri, async (_, s) => { count++; active = false; return { segmentId: s.id, text: s.text, lineId: 'b', verdict: 'complete' }; }, () => active);
  assert.equal(count, 1);
  assert.deepEqual(result, []);
});
test('fumbled verdicts remain evidence and do not change the source transcript', async () => {
  const p = { ...base, transcript: [seg('s', 'Shipping wait no delivery ah.')] };
  const result = await completeSourceSemantics(p, p.videoUri, async (_, s) => ({ segmentId: s.id, text: s.text, lineId: 'b', verdict: 'fumbled' }), () => true);
  assert.equal(result[0].verdict, 'fumbled');
  assert.equal(p.transcript[0].text, 'Shipping wait no delivery ah.');
  assert.equal(p.cuts, undefined);
});
