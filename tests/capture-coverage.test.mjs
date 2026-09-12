import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveCaptureCoverage,
  pendingCaptureCoverage,
} from '../src/features/capture/coverage.ts';
import { parseScript } from '../src/lib/script-lines.ts';
import { createTranscriptSegment } from '../src/lib/transcript-workflow.ts';

function finalSegment(id, text, t0 = 0, t1 = 1) {
  return createTranscriptSegment({ id, text, t0, t1, isFinal: true });
}

test('recording-time coverage stays pending until a real saved URI exists', () => {
  const document = parseScript('Say hello. Say goodbye. [smile]');
  const snapshot = pendingCaptureCoverage(document);

  assert.deepEqual(snapshot.lines.map(line => line.status), ['pending', 'pending', 'pending']);
  assert.equal(snapshot.safeToWrap, false);
  assert.deepEqual(snapshot.lineEnds, []);
  assert.deepEqual(snapshot.verdicts, []);
});

test('a final transcript and playable URI feed the shared coverage engine', () => {
  const document = parseScript('Say hello. Say goodbye. [smile]');
  const snapshot = deriveCaptureCoverage({
    document,
    takeId: 'take-1',
    videoUri: 'file:///take-1.mp4',
    transcript: [finalSegment('segment-1', 'Say hello.'), finalSegment('segment-2', 'Say goodbye.', 1, 2)],
  });

  assert.deepEqual(snapshot.lines.map(line => line.status), ['covered', 'covered', 'needed']);
  assert.equal(snapshot.safeToWrap, true);
  assert.deepEqual(snapshot.review.lines.map(line => line.status), ['covered', 'covered']);
  assert.deepEqual(snapshot.review.takes.map(take => take.mediaUri), ['file:///take-1.mp4', 'file:///take-1.mp4']);
});

test('missing media, provisional speech, and scratched takes never claim coverage', () => {
  const document = parseScript('Say hello.');
  const segment = finalSegment('segment-1', 'Say hello.');

  assert.equal(deriveCaptureCoverage({ document, takeId: 'take-1', videoUri: null, transcript: [segment] }).lines[0].status, 'pending');
  assert.equal(deriveCaptureCoverage({
    document,
    takeId: 'take-2',
    videoUri: 'file:///take-2.mp4',
    transcript: [{ ...segment, isFinal: false }],
  }).lines[0].status, 'pending');
  assert.equal(deriveCaptureCoverage({
    document,
    takeId: 'take-3',
    videoUri: 'file:///take-3.mp4',
    transcript: [segment],
    scratched: true,
  }).lines[0].status, 'needed');
});

test('required action cues remain a separate manual wrap gate', () => {
  const first = parseScript('Say hello. [smile]');
  const cueId = first.lines[1].actionCues[0].id;
  const document = {
    ...first,
    lines: first.lines.map(line => line.id === first.lines[1].id
      ? { ...line, actionCues: line.actionCues.map(cue => cue.id === cueId ? { ...cue, required: true } : cue) }
      : line),
  };
  const snapshot = deriveCaptureCoverage({
    document,
    takeId: 'take-1',
    videoUri: 'file:///take-1.mp4',
    transcript: [finalSegment('segment-1', 'Say hello.')],
  });

  assert.deepEqual(snapshot.unresolvedRequiredActionCueIds, [cueId]);
  assert.equal(snapshot.safeToWrap, false);
});
