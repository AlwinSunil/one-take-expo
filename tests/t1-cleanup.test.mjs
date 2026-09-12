import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCleanupDecision,
  createCleanupPlan,
  generateCleanupSuggestions,
  prepareCleanupRemoval,
  restoreCleanupDecision,
} from '../src/features/speech-control/cleanup.ts';

const segment = (id, t0, t1, text, extra = {}) => ({ id, t0, t1, text, isFinal: true, ...extra });

test('cleanup replay records long silence but preserves deliberate pauses and original segments', () => {
  const original = [segment('one', 0, 1, 'First take'), segment('two', 3, 4, 'Second take')];
  const suggestions = generateCleanupSuggestions({
    segments: original,
    silences: [
      { id: 'quiet', t0: 1, t1: 2.5, verifiedBoundary: true },
      { id: 'pause', t0: 4, t1: 6, deliberate: true, verifiedBoundary: true },
    ],
  });
  assert.deepEqual(suggestions.map(({ id }) => id), ['silence:quiet']);
  assert.equal(suggestions[0].safeBoundary, 'uncertain');
  assert.equal(suggestions[0].canPrepareRemoval, false);
  assert.deepEqual(original.map(({ id }) => id), ['one', 'two']);
});

test('only explicit independent boundary records can prepare a silence removal', () => {
  const [suggestion] = generateCleanupSuggestions({
    segments: [],
    silences: [{
      id: 'quiet', recordingId: 'recording-a', t0: 1, t1: 2.5,
      startBoundary: { source: 'independent-silence', verified: true },
      endBoundary: { source: 'independent-silence', verified: true },
    }],
  });
  assert.equal(suggestion.safeBoundary, 'safe');
  assert.equal(suggestion.canPrepareRemoval, true);
  const [savedAudio] = generateCleanupSuggestions({
    segments: [],
    silences: [{
      id: 'saved', t0: 3, t1: 5, boundarySource: 'saved-audio', verifiedBoundary: true,
    }],
  });
  assert.equal(savedAudio.canPrepareRemoval, false);
});

test('restart and suitable repeat candidates use concrete transcript evidence but never claim safe ASR boundaries', () => {
  const suggestions = generateCleanupSuggestions({
    segments: [
      segment('short', 0, 1, 'I want to'),
      segment('complete', 1.3, 3, 'I want to show this clearly'),
      segment('repeat-a', 5, 6, 'The result is ready'),
      segment('repeat-b', 6.5, 7.5, 'The result is ready'),
    ],
  });
  const restart = suggestions.find(({ kind }) => kind === 'restarted-attempt');
  const repeat = suggestions.find(({ kind }) => kind === 'suitable-repeat');
  assert.equal(restart.preferredSegmentId, 'complete');
  assert.match(restart.evidence[0].detail, /3-word prefix/);
  assert.equal(restart.safeToRemove, false);
  assert.equal(repeat.preferredSegmentId, 'repeat-b');
  assert.equal(repeat.startBoundary.source, 'recognition-only');
  assert.equal(repeat.canPrepareRemoval, false);
});

test('cleanup never compares separate recording identities or chooses an uncertain later repeat', () => {
  const suggestions = generateCleanupSuggestions({
    segments: [
      segment('old', 0, 1, 'The result is ready', { recordingId: 'old-recording' }),
      segment('new', 1.1, 2.1, 'The result is ready', { recordingId: 'new-recording' }),
      segment('uncertain', 3, 4, 'The result is ready', { recordingId: 'new-recording', confidence: 0.2 }),
    ],
  });
  assert.equal(suggestions.some(({ kind }) => kind === 'suitable-repeat'), false);
});

test('uncertainty, mumble and mid-sentence filler stay review marks without invented removals', () => {
  const suggestions = generateCleanupSuggestions({
    segments: [segment('uncertain', 0, 1, 'maybe this', { confidence: 0.2 })],
    marks: [
      { id: 'filler-mid', kind: 'filler', text: 'um', t0: 1, t1: 1.2, isMidSentence: true, safeBoundary: true },
      { id: 'mumble', kind: 'mumble', text: 'unclear word', t0: 2, t1: 2.5, safeBoundary: false },
    ],
  });
  const uncertain = suggestions.find(({ kind }) => kind === 'uncertain');
  const filler = suggestions.find(({ kind }) => kind === 'filler');
  const mumble = suggestions.find(({ kind }) => kind === 'mumble');
  assert.equal(uncertain.action, 'mark');
  assert.equal(uncertain.removalInterval, null);
  assert.equal(filler.action, 'mark');
  assert.match(filler.reason, /mid-sentence/);
  assert.equal(filler.removal, null);
  assert.equal(mumble.action, 'mark');
  assert.equal(mumble.safeBoundary, 'uncertain');
});

test('unknown sentence placement keeps filler and mumble marks review-only', () => {
  const suggestions = generateCleanupSuggestions({
    segments: [],
    recordingId: 'recording-a',
    marks: [
      {
        id: 'filler-unknown', kind: 'filler', text: 'um', t0: 1, t1: 1.2,
        startBoundary: { source: 'independent-silence', verified: true },
        endBoundary: { source: 'independent-silence', verified: true },
      },
      {
        id: 'mumble-unknown', kind: 'mumble', text: 'unclear', t0: 2, t1: 2.3,
        startBoundary: { source: 'independent-silence', verified: true },
        endBoundary: { source: 'independent-silence', verified: true },
      },
    ],
  });
  assert.equal(suggestions.every(({ action, canPrepareRemoval }) => action === 'mark' && !canPrepareRemoval), true);
  assert.match(suggestions[0].reason, /confirmed sentence-boundary placement/);
});

test('explicitly verified filler boundaries still require a reversible creator decision', () => {
  const [suggestion] = generateCleanupSuggestions({
    segments: [],
    fillerMarks: [{
      id: 'filler', kind: 'filler', recordingId: 'recording-a', text: 'um', isMidSentence: false, t0: 1, t1: 1.25,
      startBoundary: { source: 'independent-silence', verified: true },
      endBoundary: { source: 'independent-silence', verified: true },
    }],
  });
  assert.equal(suggestion.canPrepareRemoval, true);
  assert.equal(prepareCleanupRemoval(suggestion, []), null);
  const accepted = applyCleanupDecision([], suggestion, 'accept');
  assert.deepEqual(prepareCleanupRemoval(suggestion, accepted), { t0: 1, t1: 1.25 });
  const dismissed = applyCleanupDecision(accepted, suggestion, 'dismiss');
  assert.equal(prepareCleanupRemoval(suggestion, dismissed), null);
  assert.deepEqual(restoreCleanupDecision(dismissed, dismissed[0].id), []);
});

test('recording identity is carried into decisions so an old accept cannot remove a new recording', () => {
  const [suggestion] = generateCleanupSuggestions({
    segments: [],
    fillerMarks: [{
      id: 'filler', kind: 'filler', text: 'um', t0: 1, t1: 1.25, recordingId: 'recording-b',
      startBoundary: { source: 'manual-review', verified: true },
      endBoundary: { source: 'manual-review', verified: true },
    }],
  });
  const oldDecision = { id: 'cleanup:filler:filler', suggestionId: suggestion.id, action: 'accept', recordingId: 'recording-a' };
  assert.equal(prepareCleanupRemoval(suggestion, [oldDecision]), null);
});

test('a changed interval cannot inherit an old accept even when the suggestion id is reused', () => {
  const [original] = generateCleanupSuggestions({
    segments: [],
    recordingId: 'recording-a',
    fillerMarks: [{
      id: 'filler', text: 'um', t0: 1, t1: 1.25,
      startBoundary: { source: 'independent-silence', verified: true },
      endBoundary: { source: 'independent-silence', verified: true },
    }],
  });
  const accepted = applyCleanupDecision([], original, 'accept');
  const [regenerated] = generateCleanupSuggestions({
    segments: [],
    recordingId: 'recording-a',
    fillerMarks: [{
      id: 'filler', text: 'um', t0: 1.1, t1: 1.35,
      startBoundary: { source: 'independent-silence', verified: true },
      endBoundary: { source: 'independent-silence', verified: true },
    }],
  });
  assert.equal(original.id, regenerated.id);
  assert.notEqual(original.fingerprint, regenerated.fingerprint);
  assert.equal(prepareCleanupRemoval(regenerated, accepted), null);
});

test('changed mark evidence invalidates an old accept fingerprint', () => {
  const [original] = generateCleanupSuggestions({
    segments: [],
    recordingId: 'recording-a',
    marks: [{
      id: 'filler', kind: 'filler', text: 'um', isMidSentence: false, t0: 1, t1: 1.25,
      startBoundary: { source: 'manual-review', verified: true },
      endBoundary: { source: 'manual-review', verified: true },
    }],
  });
  const accepted = applyCleanupDecision([], original, 'accept');
  const [changed] = generateCleanupSuggestions({
    segments: [],
    recordingId: 'recording-a',
    marks: [{
      id: 'filler', kind: 'filler', text: 'uh', isMidSentence: false, t0: 1, t1: 1.25,
      startBoundary: { source: 'manual-review', verified: true },
      endBoundary: { source: 'manual-review', verified: true },
    }],
  });
  assert.notEqual(original.fingerprint, changed.fingerprint);
  assert.equal(prepareCleanupRemoval(changed, accepted), null);
});

test('same suggestion ids from different recordings keep separate decisions', () => {
  const make = (recordingId) => generateCleanupSuggestions({
    segments: [],
    recordingId,
    marks: [{
      id: 'same-mark', kind: 'filler', text: 'um', isMidSentence: false, t0: 1, t1: 1.25,
      startBoundary: { source: 'manual-review', verified: true },
      endBoundary: { source: 'manual-review', verified: true },
    }],
  })[0];
  const first = make('recording-a');
  const second = make('recording-b');
  const decisions = applyCleanupDecision(applyCleanupDecision([], first, 'accept'), second, 'dismiss');
  assert.equal(decisions.length, 2);
  assert.notEqual(decisions[0].id, decisions[1].id);
  assert.equal(prepareCleanupRemoval(first, decisions)?.t0, 1);
  assert.equal(prepareCleanupRemoval(second, decisions), null);
});

test('cleanup plan is deterministic and carries prior decisions while retaining all observations', () => {
  const decisions = [{ id: 'cleanup:silence:old', suggestionId: 'silence:old', action: 'dismiss' }];
  const plan = createCleanupPlan({
    segments: [segment('a', 0, 1, 'hello')],
    decisions,
    silences: [{ id: 'old', t0: 1, t1: 3 }],
  });
  assert.equal(plan.originalSegments.length, 1);
  assert.deepEqual(plan.decisions, decisions);
  assert.equal(plan.suggestions[0].requiresReview, true);
  assert.equal(plan.suggestions[0].reversible, true);
});
