import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptSuggestion,
  applyScriptEdits,
  applyTranscriptRefinement,
  createScriptLine,
  createTranscriptSegment,
  deriveReviewState,
  displayTranscriptText,
  editCaption,
  generateReviewSuggestions,
  matchTranscriptToScript,
  restoreDecision,
  selectTake,
} from '../src/lib/transcript-workflow.ts';

function line(id, text, actionCues) {
  return createScriptLine({ id, text, actionCues });
}

function segment(id, t0, t1, text, isFinal = true, revision = 1) {
  return createTranscriptSegment({ id, t0, t1, text, isFinal, revision });
}

function take(id, segmentIds, overrides = {}) {
  return {
    id,
    t0: overrides.t0 ?? 0,
    t1: overrides.t1 ?? 2,
    mediaUri: overrides.mediaUri ?? `file:///tmp/${id}.mp4`,
    playable: overrides.playable ?? true,
    quality: overrides.quality ?? 'clean',
    inFrame: overrides.inFrame ?? true,
    transcriptSegmentIds: segmentIds,
    lineIds: overrides.lineIds,
  };
}

test('manual caption edits survive a later refinement while the stable segment id and raw text remain', () => {
  const original = segment('recording-a:utterance-1', 0, 1.2, 'the pixel nine');
  const edited = editCaption([original], original.id, 'The Pixel 9');

  const refined = applyTranscriptRefinement(edited, [
    { ...original, text: 'the pixel 9', isFinal: true, revision: 2, t0: 0.1, t1: 1.3 },
  ]);

  assert.equal(refined[0].id, original.id);
  assert.equal(refined[0].text, 'the pixel 9');
  assert.equal(refined[0].manualCorrection, 'The Pixel 9');
  assert.equal(displayTranscriptText(refined[0]), 'The Pixel 9');
  assert.equal(refined[0].t0, 0.1);
  assert.equal(refined[0].t1, 1.3);

  const late = applyTranscriptRefinement(refined, [
    { ...original, text: 'a stale late result', isFinal: false, revision: 1 },
  ]);
  assert.deepEqual(late, refined);

  const lateProvisional = applyTranscriptRefinement(refined, [
    { ...original, text: 'a provisional downgrade', isFinal: false, revision: 3 },
  ]);
  assert.deepEqual(lateProvisional, refined);
});

test('script matching uses whole normalized token sequences for numbers and common brand forms', () => {
  const script = [line('line-1', 'OpenAI released Pixel 9'), line('line-2', 'today')];
  const matched = matchTranscriptToScript(
    segment('u-1', 0, 2, 'open ai released pixel nine'),
    script,
  );

  assert.deepEqual(matched.lineIds, ['line-1']);
  assert.equal(matched.kind, 'normalized');
  assert.deepEqual(
    matchTranscriptToScript(segment('u-2', 0, 1, 'pixel'), [line('line-3', 'Pixel 9')]).lineIds,
    [],
  );
});

test('one final utterance can cover consecutive script lines as one media take', () => {
  const script = [line('line-1', 'Start the camera.'), line('line-2', 'Look into the lens.')];
  const utterance = segment('u-1', 0, 2.4, 'Start the camera. Look into the lens.');
  const match = matchTranscriptToScript(utterance, script);

  assert.deepEqual(match.lineIds, ['line-1', 'line-2']);

  const review = deriveReviewState({
    lines: script,
    segments: [utterance],
    takes: [take('take-1', ['u-1'], { t1: 2.4, lineIds: match.lineIds })],
  });
  assert.deepEqual(review.lines.map(({ id, status, selectedTakeId }) => ({ id, status, selectedTakeId })), [
    { id: 'line-1', status: 'covered', selectedTakeId: 'take-1' },
    { id: 'line-2', status: 'covered', selectedTakeId: 'take-1' },
  ]);
});

test('script edits preserve explicit line ids and do not delete historical takes', () => {
  const original = [line('a', 'First'), line('b', 'Second'), line('c', 'Third')];
  const edited = applyScriptEdits(original, [
    { type: 'update', lineId: 'a', text: 'First revised' },
    { type: 'reorder', lineIds: ['c', 'a', 'b'] },
    { type: 'delete', lineId: 'b' },
    { type: 'insert', line: { id: 'd', text: 'New line' }, beforeLineId: 'c' },
  ]);

  assert.deepEqual(edited.map(({ id, spokenText }) => [id, spokenText]), [
    ['d', 'New line'],
    ['c', 'Third'],
    ['a', 'First revised'],
  ]);
  assert.deepEqual(original.map(({ id }) => id), ['a', 'b', 'c']);
});

test('coverage distinguishes needed, pending and covered and retains an earlier clean take after a bad reread', () => {
  const script = [line('a', 'Say hello'), line('b', 'Say goodbye'), line('c', 'Say later')];
  const finalA = segment('a-final', 0, 1, 'say hello');
  const provisionalB = segment('b-live', 2, 3, 'say goodbye', false);
  const finalB = segment('b-final', 2, 3, 'say goodbye');
  const matches = [finalA, provisionalB, finalB].map((item) => [
    item,
    matchTranscriptToScript(item, script).lineIds,
  ]);

  const review = deriveReviewState({
    lines: script,
    segments: [finalA, provisionalB, finalB],
    takes: [
      take('good-a', ['a-final'], { lineIds: matches[0][1] }),
      take('bad-a', ['a-final'], { quality: 'flub', lineIds: matches[0][1] }),
      take('pending-b', ['b-live'], { lineIds: matches[1][1] }),
      take('missing-b', ['b-final'], { mediaUri: null, playable: false, lineIds: matches[2][1] }),
    ],
  });

  assert.equal(review.lines.find(({ id }) => id === 'a').status, 'covered');
  assert.equal(review.lines.find(({ id }) => id === 'a').selectedTakeId, 'good-a');
  assert.equal(review.lines.find(({ id }) => id === 'b').status, 'pending');
  assert.deepEqual(review.lines.find(({ id }) => id === 'b').missingMediaTakeIds, ['missing-b']);
  assert.equal(review.lines.find(({ id }) => id === 'c').status, 'needed');
});

test('a take linked to mixed final and provisional utterances stays pending only for the provisional line', () => {
  const script = [line('a', 'Say hello'), line('b', 'Say goodbye')];
  const finalA = segment('a-final', 0, 1, 'say hello');
  const provisionalB = segment('b-live', 1.2, 2.2, 'say goodbye', false);
  const review = deriveReviewState({
    lines: script,
    segments: [finalA, provisionalB],
    takes: [take('take', ['a-final', 'b-live'], { lineIds: ['a', 'b'] })],
  });

  assert.equal(review.lines.find(({ id }) => id === 'a').status, 'covered');
  assert.equal(review.lines.find(({ id }) => id === 'b').status, 'pending');
});

test('missing media and scratched takes never establish playable coverage', () => {
  const script = [line('a', 'Say hello')];
  const transcript = segment('u', 0, 1, 'say hello');
  const lineIds = matchTranscriptToScript(transcript, script).lineIds;
  const review = deriveReviewState({
    lines: script,
    segments: [transcript],
    takes: [
      take('missing', ['u'], { mediaUri: null, playable: false, lineIds }),
      take('scratched', ['u'], { quality: 'scratched', lineIds }),
    ],
  });

  assert.equal(review.lines[0].status, 'pending');
  assert.equal(review.lines[0].selectedTakeId, null);
  assert.deepEqual(review.lines[0].candidateTakeIds, ['missing']);
  assert.deepEqual(review.lines[0].rejectedTakeIds, ['scratched']);
});

test('an in-frame clean take wins over an otherwise suitable off-frame take', () => {
  const script = [line('a', 'Say hello')];
  const transcript = segment('u', 0, 1, 'say hello');
  const lineIds = matchTranscriptToScript(transcript, script).lineIds;
  const review = deriveReviewState({
    lines: script,
    segments: [transcript],
    takes: [
      take('off-frame', ['u'], { inFrame: false, lineIds }),
      take('in-frame', ['u'], { inFrame: true, lineIds }),
    ],
  });
  assert.equal(review.lines[0].selectedTakeId, 'in-frame');
});

test('required action cues remain separate from speech and block safe-to-wrap until manually resolved', () => {
  const script = [line('a', 'Say hello [smile]', [
    { id: 'cue-smile', text: 'smile', required: true, resolved: false },
  ])];
  const transcript = segment('u', 0, 1, 'say hello');
  const lineIds = matchTranscriptToScript(transcript, script).lineIds;
  const review = deriveReviewState({
    lines: script,
    segments: [transcript],
    takes: [take('take', ['u'], { lineIds })],
  });

  assert.equal(script[0].spokenText, 'Say hello');
  assert.equal(review.lines[0].status, 'covered');
  assert.deepEqual(review.unresolvedRequiredActionCueIds, ['cue-smile']);
  assert.equal(review.safeToWrap, false);
});

test('cue-only script lines do not create an ambiguous spoken match', () => {
  const script = [line('a', 'Say hello'), line('cue', '[wave]')];
  const match = matchTranscriptToScript(segment('u', 0, 1, 'say hello'), script);
  assert.deepEqual(match.lineIds, ['a']);
});

test('silence and repeated-attempt suggestions are review-only and retain original transcript segments', () => {
  const first = segment('u-1', 0, 1, 'say hello');
  const second = segment('u-2', 3, 4, 'say hello');
  const segments = [first, second];
  const suggestions = generateReviewSuggestions({
    segments,
    silences: [{ id: 'silence-1', t0: 1, t1: 3, verifiedBoundary: false }],
  });

  assert.deepEqual(suggestions.map(({ kind }) => kind), ['repeated-attempt', 'long-silence']);
  assert.equal(suggestions[1].safeBoundary, 'uncertain');
  assert.deepEqual(segments, [first, second]);

  const decisions = acceptSuggestion([], suggestions[1]);
  assert.deepEqual(decisions, [{
    id: `cleanup:${suggestions[1].id}`,
    type: 'cleanup',
    suggestionId: suggestions[1].id,
    action: 'accept',
  }]);
  assert.deepEqual(restoreDecision(decisions, decisions[0].id), []);
});

test('take selection is explicit, reversible and rejects unavailable media', () => {
  const available = take('available', [], { lineIds: ['a'] });
  const missing = take('missing', [], { lineIds: ['a'], mediaUri: null, playable: false });
  const decisions = selectTake([], 'a', 'available', [available, missing]);
  assert.deepEqual(decisions, [{ id: 'take:a', type: 'take-selection', lineId: 'a', takeId: 'available' }]);
  assert.deepEqual(restoreDecision(decisions, 'take:a'), []);
  assert.throws(() => selectTake([], 'a', 'missing', [available, missing]), /playable/);
});
