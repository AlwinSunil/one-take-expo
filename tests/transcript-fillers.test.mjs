import assert from 'node:assert/strict';
import test from 'node:test';

import { splitFillerText, transcriptFillerMarks } from '../src/lib/transcript-fillers.ts';

test('splitFillerText preserves exact punctuation and spacing around vocal fillers', () => {
  const text = 'Wait, um...  UH? erm!';
  const parts = splitFillerText(text);

  assert.deepEqual(parts, [
    { text: 'Wait, ', isFiller: false },
    { text: 'um', isFiller: true },
    { text: '...  ', isFiller: false },
    { text: 'UH', isFiller: true },
    { text: '? ', isFiller: false },
    { text: 'erm', isFiller: true },
    { text: '!', isFiller: false },
  ]);
  assert.equal(parts.map(part => part.text).join(''), text);
});

test('splitFillerText recognizes only whole unambiguous vocal tokens', () => {
  const text = 'um umm uh uhh erm er hmm summer thummer hmmm like so well';
  const fillers = splitFillerText(text).filter(part => part.isFiller).map(part => part.text.toLowerCase());

  assert.deepEqual(fillers, ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'hmm']);
  assert.equal(splitFillerText('summer').some(part => part.isFiller), false);
  assert.equal(splitFillerText('hmmm').some(part => part.isFiller), false);
});

test('transcriptFillerMarks uses the effective corrected display text and stable identities', () => {
  const segment = {
    id: 'take-1:caption-1',
    recordingId: 'take-1',
    t0: 2,
    t1: 6,
    text: 'um original',
    correctedText: 'uh corrected',
    manualCorrection: null,
  };

  const first = transcriptFillerMarks([segment]);
  const second = transcriptFillerMarks([segment]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(mark => mark.label), ['uh']);
  assert.equal(first[0].segmentId, segment.id);
  assert.equal(first[0].recordingId, segment.recordingId);

  const manuallyCorrected = transcriptFillerMarks([{ ...segment, manualCorrection: 'Keep um here' }]);
  assert.deepEqual(manuallyCorrected.map(mark => mark.label), ['um']);
});

test('transcriptFillerMarks bounds approximate token ranges and skips invalid segments', () => {
  const marks = transcriptFillerMarks([
    { id: 'valid', recordingId: 'original', t0: -1, t1: 5, text: 'um at end' },
    { id: 'outside', t0: 7, t1: 9, text: 'uh' },
    { id: 'empty-range', t0: 3, t1: 3, text: 'um' },
    { id: 'bad-text', t0: 0, t1: 1, text: '' },
  ], 4);

  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, 'um');
  assert.ok(marks[0].t0 >= 0);
  assert.ok(marks[0].t1 <= 4);
  assert.ok(marks[0].t1 > marks[0].t0);
  assert.equal(marks[0].recordingId, 'original');
});

test('partial live text uses the same splitter without requiring a completed sentence', () => {
  const parts = splitFillerText('I think uh');
  assert.deepEqual(parts, [
    { text: 'I think ', isFiller: false },
    { text: 'uh', isFiller: true },
  ]);
});
test('offline filler markers show exact ranges while live words remain estimates', () => {
  const segment = { id: 's', text: 'A useful um tool.', t0: 0, t1: 5, words: [{ text: 'um', t0: 1.3, t1: 1.7, confidence: 0.95 }] };
  const exact = transcriptFillerMarks([{ ...segment, wordTimingSource: 'saved-audio' }]);
  assert.deepEqual(exact.map(m => [m.t0, m.t1]), [[1.3, 1.7]]);
  assert.notEqual(transcriptFillerMarks([{ ...segment, timingSource: 'live-estimate' }])[0].t0, 1.3);
});
test('elongated fillers are recognized without matching word fragments or the ER acronym', () => {
  assert.deepEqual(splitFillerText('ummm uhhhh ermm ER summer thermal').filter(p => p.isFiller).map(p => p.text), ['ummm', 'uhhhh', 'ermm']);
});
