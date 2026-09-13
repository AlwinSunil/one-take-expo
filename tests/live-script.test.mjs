import test from 'node:test';
import assert from 'node:assert/strict';
import { liveScriptCoverage } from '../src/features/capture/live-script.ts';
const lines = [{ id: 'a', spokenText: 'Delivery is always free.' }, { id: 'b', spokenText: 'Returns are accepted for thirty days.' }];
test('complete script sentences can span recognizer utterances', () => {
  const result = liveScriptCoverage(lines, [{ id: '1', text: 'Delivery is', isFinal: true }, { id: '2', text: 'always free.', isFinal: true }]);
  assert.equal(result[0].status, 'covered');
});
test('final semantic paraphrases advance coverage, stale revisions do not', () => {
  const text = 'Shipping never costs you anything.';
  const semantic = [{ segmentId: 's', text, lineId: 'a', verdict: 'complete' }];
  assert.equal(liveScriptCoverage(lines, [{ id: 's', text, isFinal: true }], semantic)[0].status, 'covered');
  assert.notEqual(liveScriptCoverage(lines, [{ id: 's', text: 'Shipping costs money.', isFinal: true }], semantic)[0].status, 'covered');
  assert.notEqual(liveScriptCoverage(lines, [{ id: 's', text, isFinal: false }], semantic)[0].status, 'covered');
});

test('automatic retake rejects delayed revisions and speech that moved on', async () => {
  const { canAutoRetake } = await import('../src/features/capture/live-script.ts');
  const segment = { id: 's', text: 'Returns are um no wait', isFinal: true, t0: 2, t1: 4 };
  const match = { segmentId: 's', text: segment.text, lineId: 'b', verdict: 'fumbled' };
  assert.equal(canAutoRetake(match, segment, [segment], lines), true);
  assert.equal(canAutoRetake(match, segment, [{ ...segment, text: lines[1].spokenText }], lines), false);
  assert.equal(canAutoRetake(match, segment, [{ ...segment, t1: 5 }], lines), false);
  assert.equal(canAutoRetake(match, segment, [{ ...segment, isFinal: false }], lines), false);
  assert.equal(canAutoRetake(match, segment, [segment, { ...segment, id: 'next' }], lines), false);
});

test('automatic retake preserves an utterance containing a completed line', async () => {
  const { canAutoRetake } = await import('../src/features/capture/live-script.ts');
  const segment = { id: 's', text: 'Delivery is always free. Returns um no', isFinal: true, t0: 2, t1: 4 };
  const match = { segmentId: 's', text: segment.text, lineId: 'b', verdict: 'fumbled' };
  assert.equal(canAutoRetake(match, segment, [segment], lines), false);
});

test('coverage never joins incomplete lines from different recording sources', () => {
  const result = liveScriptCoverage(lines, [{ id: '1', text: 'Delivery is', isFinal: true }, { id: '2', recordingId: 'pickup', text: 'always free.', isFinal: true }]);
  assert.notEqual(result[0].status, 'covered');
});

test('an unspoken next line is not flagged during a planned reading pause', async () => {
  const { missedImportantLine } = await import('../src/features/capture/live-script.ts');
  const spoken = [{ id: 's', text: lines[0].spokenText, isFinal: true, t0: 0, t1: 2 }];
  assert.equal(missedImportantLine(lines, spoken, [], ['b'], 3), undefined);
  assert.equal(missedImportantLine(lines, spoken, [], ['b'], 20), undefined);
  assert.equal(missedImportantLine(lines, [], [], ['b'], 20), undefined);
});
test('moving beyond an important line flags it and rereading clears the reminder', async () => {
  const { missedImportantLine } = await import('../src/features/capture/live-script.ts');
  const spoken = [{ id: 'b', text: lines[1].spokenText, isFinal: true, t0: 0, t1: 2 }];
  assert.equal(missedImportantLine(lines, spoken, [], ['a'], 2.1)?.id, 'a');
  assert.equal(missedImportantLine(lines, [...spoken, { id: 'a', text: lines[0].spokenText, isFinal: true, t0: 3, t1: 5 }], [], ['a'], 5.1), undefined);
});
test('pending paraphrase has bounded grace and a confirmed paraphrase clears reminders', async () => {
  const { missedImportantLine } = await import('../src/features/capture/live-script.ts');
  const spoken = [{ id: 's', text: 'Shipping never costs you anything.', isFinal: true, t0: 0, t1: 2 },
    { id: 'next', text: lines[1].spokenText, isFinal: true, t0: 2.2, t1: 3 }];
  assert.equal(missedImportantLine(lines, spoken, [], ['a'], 4, new Set(['s'])), undefined);
  assert.equal(missedImportantLine(lines, spoken, [], ['a'], 5.1, new Set(['s']))?.id, 'a');
  const meaning = [{ segmentId: 's', text: spoken[0].text, lineId: 'a', verdict: 'complete' }];
  assert.equal(missedImportantLine(lines, spoken, meaning, ['a'], 5.1), undefined);
});
