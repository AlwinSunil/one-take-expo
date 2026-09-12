import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createManualScratchEvent,
  createRestoreScratchEvent,
  createTake,
  createTakeDecisionState,
  createVoiceScratchEvent,
  deriveTakeReasons,
  detectScratchCommand,
  flagTake,
  reduceTakeDecision,
} from '../src/features/speech-control/take-decisions.ts';

const scope = { sessionId: 'session-1', sourceId: 'recording-1' };

function transcript(id, t0, t1, text, overrides = {}) {
  return {
    id,
    sessionId: scope.sessionId,
    sourceId: scope.sourceId,
    t0,
    t1,
    text,
    isFinal: true,
    state: 'final',
    commandContext: 'standalone',
    ...overrides,
  };
}

function take(id, t0, t1, overrides = {}) {
  return createTake({
    id,
    scope,
    attempt: overrides.attempt ?? 0,
    t0,
    t1,
    lifecycle: overrides.lifecycle ?? 'complete',
    lineIds: overrides.lineIds ?? ['line-1'],
    transcriptSegments: overrides.transcriptSegments ?? [],
    verdict: overrides.verdict ?? 'clean',
  });
}

async function commandFixtures() {
  const source = await readFile(new URL('../tools/fixtures/t1-commands.json', import.meta.url), 'utf8');
  return JSON.parse(source);
}

test('command fixtures accept only a final standalone command and protect literal dialogue', async () => {
  const fixture = await commandFixtures();
  assert.equal(fixture.schema, 'one-take-t1-commands/v1');
  assert.equal(fixture.source, 'synthetic');
  assert.equal(fixture.synthetic, true);

  for (const item of fixture.cases) {
    const match = detectScratchCommand({
      id: item.id,
      sessionId: fixture.scope.sessionId,
      sourceId: fixture.scope.sourceId,
      t0: item.t0,
      t1: item.t1,
      text: item.text,
      isFinal: item.isFinal,
      state: item.state,
      commandContext: item.commandContext,
      quality: item.quality,
    }, {
      scriptText: item.scriptText,
    });
    assert.equal(!!match, item.expectedCommand, item.id);
  }
});

test('a take has an allocated durable identity and retains raw transcript evidence separately from reasons', () => {
  const raw = transcript('segment-1', 0.2, 1.1, 'welcome to the studio');
  const unrelated = transcript('segment-other-take', 8, 9, 'unrelated later take');
  const original = take('take-allocated-once', 0, 1.3, {
    transcriptSegments: [raw],
    lineIds: ['line-welcome'],
  });
  const reasons = deriveTakeReasons({
    take: original,
    scriptLines: [{ lineId: 'line-welcome', text: 'Welcome to the studio today' }],
    transcriptSegments: [raw, unrelated],
  });
  const flagged = flagTake(original, reasons);

  assert.equal(flagged.id, 'take-allocated-once');
  assert.deepEqual(flagged.scope, scope);
  assert.deepEqual(flagged.transcriptSegmentIds, ['segment-1']);
  assert.equal(flagged.rawTranscript[0].rawText, 'welcome to the studio');
  assert.equal(flagged.rawTranscript[0].text, 'welcome to the studio');
  assert.equal(flagged.verdict, 'flagged');
  assert.equal(flagged.reasons[0].code, 'missing-words');
  assert.match(flagged.reasons[0].message, /today/);
  assert.deepEqual(flagged.reasons[0].scriptEvidence, [{
    lineId: 'line-welcome',
    text: 'Welcome to the studio today',
  }]);
  assert.deepEqual(flagged.reasons[0].transcriptEvidence.map(({ segmentId, rawText }) => ({ segmentId, rawText })), [{
    segmentId: 'segment-1',
    rawText: 'welcome to the studio',
  }]);

  const persistedIdsAndSnapshots = createTake({
    id: 'take-persisted-segment-link',
    scope,
    t0: 0,
    t1: 1.3,
    lineIds: ['line-welcome'],
    transcriptSegmentIds: ['segment-1'],
    transcriptSegments: [raw],
    verdict: 'clean',
  });
  assert.deepEqual(persistedIdsAndSnapshots.transcriptSegmentIds, ['segment-1']);

  assert.equal(createTake({
    id: 'take-unexplained-flag',
    scope,
    t0: 0,
    t1: 1,
    verdict: 'flagged',
  }).verdict, 'pending');
  assert.equal(flagTake(original, []).verdict, 'pending');

  assert.throws(() => createTake({
    id: 'take-foreign-evidence',
    scope,
    t0: 0,
    t1: 1.3,
    transcriptSegments: [{
      ...raw,
      id: 'foreign-segment',
      sessionId: 'other-session',
    }],
  }), /another source or session/);

  const persistedUnexplained = {
    ...original,
    verdict: 'flagged',
    baseVerdict: 'flagged',
    reasons: [],
  };
  assert.equal(createTakeDecisionState({
    scope,
    takes: [persistedUnexplained],
  }).takes[0].verdict, 'pending');
  assert.throws(() => createTakeDecisionState({
    scope,
    takes: [{
      ...original,
      rawTranscript: [{ ...raw, id: 'foreign-rehydrated', sourceId: 'other-recording' }],
      transcriptSegmentIds: ['foreign-rehydrated'],
    }],
  }), /another source or session/);
  assert.throws(() => createTakeDecisionState({
    scope,
    takes: [original, { ...original }],
  }), /duplicate take id/);
});

test('reason evidence explains a restart and keeps uncertain speech honest', () => {
  const restart = transcript('segment-restart', 0, 1.8, 'sorry let me start again', {
    state: 'uncertain',
    quality: 'noisy',
  });
  const original = take('take-restart', 0, 2, {
    transcriptSegments: [restart],
  });
  const reasons = deriveTakeReasons({
    take: original,
    scriptLines: [{ lineId: 'line-1', text: 'The product is ready.' }],
    transcriptSegments: [restart],
  });

  assert.deepEqual(reasons.map(({ code, status }) => ({ code, status })), [
    { code: 'missing-words', status: 'uncertain' },
    { code: 'restart', status: 'uncertain' },
  ]);
  assert.match(reasons.find(({ code }) => code === 'restart').message, /restart/i);
  assert.equal(reasons.find(({ code }) => code === 'restart').transcriptEvidence[0].rawText, restart.text);
});

test('voice scratch targets the take active at command time even when its event arrives after a newer take', () => {
  const first = take('take-first', 0, 2, { attempt: 0 });
  const newer = take('take-newer', 5, 7, { attempt: 1 });
  const commandSegment = transcript('command-1', 2.1, 2.7, 'scratch that');
  const event = createVoiceScratchEvent({
    id: 'scratch-voice-1',
    scope,
    commandSegment,
    takes: [first, newer],
  });

  assert.equal(event.takeId, 'take-first');
  assert.equal(event.commandSegmentId, 'command-1');
  assert.equal(event.commandInterval.safeForSplice, false);
  assert.equal(event.commandInterval.excludeFromCaptions, true);
  assert.equal(event.commandInterval.excludeFromPlayback, true);
  assert.equal(event.commandInterval.playbackExclusion, 'pending-review');
  assert.equal(event.commandInterval.boundaryProvenance, 'recognition');

  const state = createTakeDecisionState({ scope, takes: [first, newer] });
  const scratched = reduceTakeDecision(state, event);
  assert.deepEqual(scratched.takes.map(({ id, verdict }) => ({ id, verdict })), [
    { id: 'take-first', verdict: 'scratched' },
    { id: 'take-newer', verdict: 'clean' },
  ]);
  assert.deepEqual(scratched.commandIntervals.map(({ segmentId }) => segmentId), ['command-1']);
});

test('manual and voice scratch produce the same reversible take outcome while history remains append-only', () => {
  const original = take('take-one', 0, 2);
  const state = createTakeDecisionState({ scope, takes: [original] });
  const voice = createVoiceScratchEvent({
    id: 'scratch-voice',
    scope,
    commandSegment: transcript('command-voice', 2.1, 2.5, 'scratch that'),
    takes: [original],
  });
  const manual = createManualScratchEvent({ id: 'scratch-manual', scope, takeId: original.id });

  const voiceState = reduceTakeDecision(state, voice);
  const manualState = reduceTakeDecision(state, manual);
  assert.equal(voiceState.takes[0].verdict, manualState.takes[0].verdict);
  assert.equal(voiceState.takes[0].verdict, 'scratched');
  assert.equal(voiceState.scratchHistory[0].state, 'applied');
  assert.equal(manualState.scratchHistory[0].state, 'applied');
  assert.equal(manualState.commandIntervals.length, 0);

  const restore = createRestoreScratchEvent({
    id: 'restore-voice',
    scope,
    scratchEventId: voice.id,
  });
  const restored = reduceTakeDecision(voiceState, restore);
  assert.equal(restored.takes[0].verdict, 'clean');
  assert.deepEqual(restored.events.map(({ id }) => id), ['scratch-voice', 'restore-voice']);
  assert.deepEqual(restored.scratchHistory.map(({ id, state }) => ({ id, state })), [{
    id: 'scratch-voice',
    state: 'restored',
  }]);
  assert.equal(restored.commandIntervals.length, 1);
});

test('a restore can only undo an earlier scratch event and cannot cancel a later event', () => {
  const original = take('take-restore-order', 0, 2);
  const initial = createTakeDecisionState({ scope, takes: [original] });
  const unknownRestore = createRestoreScratchEvent({
    id: 'restore-before-scratch',
    scope,
    scratchEventId: 'scratch-later',
  });
  const scratchLater = createManualScratchEvent({
    id: 'scratch-later',
    scope,
    takeId: original.id,
  });
  assert.equal(reduceTakeDecision(initial, unknownRestore), initial);
  const state = createTakeDecisionState({
    scope,
    takes: [original],
    events: [unknownRestore, scratchLater],
  });

  assert.deepEqual(state.events.map(({ id }) => id), ['scratch-later']);
  assert.equal(state.takes[0].verdict, 'scratched');
});

test('replaying an event or applying an event from another source/session is idempotent and cannot scratch a take', () => {
  const original = take('take-replay', 0, 2);
  const state = createTakeDecisionState({ scope, takes: [original] });
  const event = createManualScratchEvent({ id: 'scratch-once', scope, takeId: original.id });
  const once = reduceTakeDecision(state, event);
  const twice = reduceTakeDecision(once, event);
  assert.deepEqual(twice, once);

  const foreign = createManualScratchEvent({
    id: 'scratch-foreign',
    scope: { sessionId: 'other-session', sourceId: scope.sourceId },
    takeId: original.id,
  });
  const afterForeign = reduceTakeDecision(once, foreign);
  assert.deepEqual(afterForeign, once);
  assert.deepEqual(afterForeign.events.map(({ id }) => id), ['scratch-once']);
});

test('the same voice segment cannot create a second scratch and cannot fall back to an earlier good take', () => {
  const first = take('take-good', 0, 2);
  const state = createTakeDecisionState({ scope, takes: [first] });
  const voice = createVoiceScratchEvent({
    id: 'scratch-segment-first',
    scope,
    commandSegment: transcript('command-repeat', 2.1, 2.5, 'scratch that'),
    takes: [first],
  });
  const scratched = reduceTakeDecision(state, voice);
  const duplicate = { ...voice, id: 'scratch-segment-wrapper-retry' };
  const replayed = reduceTakeDecision(scratched, duplicate);

  assert.deepEqual(replayed, scratched);
  assert.equal(createVoiceScratchEvent({
    id: 'scratch-segment-late-wrapper',
    scope,
    commandSegment: transcript('command-repeat', 2.1, 2.5, 'scratch that'),
    takes: replayed.takes,
  }), null);

  const earlier = take('take-earlier', 0, 1.5);
  const latest = take('take-latest', 1.6, 2.2);
  const latestState = createTakeDecisionState({ scope, takes: [earlier, latest] });
  const scratchLatest = createManualScratchEvent({ id: 'scratch-latest', scope, takeId: latest.id });
  const afterLatestScratch = reduceTakeDecision(latestState, scratchLatest);
  assert.equal(createVoiceScratchEvent({
    id: 'scratch-must-not-reach-back',
    scope,
    commandSegment: transcript('command-after-latest', 2.3, 2.7, 'scratch that'),
    takes: afterLatestScratch.takes,
  }), null);
  assert.equal(afterLatestScratch.takes.find(({ id }) => id === earlier.id).verdict, 'clean');
});

test('a final exact phrase without explicit standalone context stays ambiguous', () => {
  const segment = transcript('command-context-unknown', 2, 2.5, 'scratch that', {
    commandContext: 'ambiguous',
  });
  assert.equal(detectScratchCommand(segment), null);
  assert.equal(detectScratchCommand({
    ...segment,
    commandContext: 'continuation',
  }), null);
  assert.equal(detectScratchCommand({
    ...segment,
    commandContext: 'standalone',
  })?.commandInterval.safeForSplice, false);
});

test('a one-breath multi-line read is checked as one utterance and ordinary try-again dialogue is not a restart flag', () => {
  const multiLine = take('take-two-lines', 0, 3, {
    lineIds: ['line-a', 'line-b'],
    transcriptSegments: [transcript('read-two-lines', 0.2, 2.8, 'first line second line')],
  });
  assert.deepEqual(deriveTakeReasons({
    take: multiLine,
    scriptLines: [
      { id: 'line-a', text: 'First line' },
      { id: 'line-b', text: 'Second line' },
    ],
    transcriptSegments: multiLine.rawTranscript,
  }), []);

  const ordinary = take('take-ordinary-try-again', 0, 2, {
    transcriptSegments: [transcript('ordinary-try-again', 0.2, 1.8, 'please try again later')],
  });
  assert.deepEqual(deriveTakeReasons({
    take: ordinary,
    scriptLines: [{ id: 'line-1', text: 'Please try again later' }],
    transcriptSegments: ordinary.rawTranscript,
  }), []);
});

test('script action cues stay out of spoken reason matching, and inferred restarts stay uncertain', () => {
  const scriptedRestart = take('take-scripted-restart', 0, 2, {
    lineIds: ['line-scripted-restart'],
    transcriptSegments: [transcript('scripted-restart', 0.2, 1.8, 'let me start again')],
  });
  assert.deepEqual(deriveTakeReasons({
    take: scriptedRestart,
    scriptLines: [{
      id: 'line-scripted-restart',
      text: '[reset gesture] Let me start again',
      spokenText: 'Let me start again',
    }],
    transcriptSegments: scriptedRestart.rawTranscript,
  }), []);

  const inferred = take('take-inferred-restart', 0, 2, {
    transcriptSegments: [transcript('inferred-restart', 0.2, 1.8, 'sorry let me start again')],
  });
  const inferredReasons = deriveTakeReasons({
    take: inferred,
    scriptLines: [{ id: 'line-inferred', text: 'The product is ready.' }],
    transcriptSegments: inferred.rawTranscript,
  });
  const inferredRestart = inferredReasons.find(({ code }) => code === 'restart');
  assert.match(inferredRestart.message, /^Possible restart/);
  assert.equal(inferredRestart.status, 'uncertain');

  const confirmedReasons = deriveTakeReasons({
    take: inferred,
    scriptLines: [{ id: 'line-inferred', text: 'The product is ready.' }],
    transcriptSegments: inferred.rawTranscript,
    confirmedRestartSegmentIds: ['inferred-restart'],
  });
  const confirmedRestart = confirmedReasons.find(({ code }) => code === 'restart');
  assert.match(confirmedRestart.message, /creator marked/i);
  assert.equal(confirmedRestart.status, 'available');
});

test('provisional, uncertain, noisy, short, ordinary cut, and scripted scratch phrases never make voice scratch events', () => {
  const original = take('take-guarded', 0, 2);
  const cases = [
    transcript('provisional', 2, 2.4, 'scratch that', { isFinal: false, state: 'provisional' }),
    transcript('uncertain', 2, 2.4, 'scratch that', { state: 'uncertain' }),
    transcript('noisy', 2, 2.4, 'scratch that', { quality: 'noisy' }),
    transcript('short', 2, 2.2, 'scratch'),
    transcript('cut-dialogue', 2, 2.6, 'cut that part'),
    transcript('ordinary-dialogue', 2, 2.8, 'we should scratch that from the plan'),
  ];

  for (const segment of cases) {
    assert.equal(createVoiceScratchEvent({
      id: `event-${segment.id}`,
      scope,
      commandSegment: segment,
      takes: [original],
    }), null, segment.id);
  }

  assert.equal(createVoiceScratchEvent({
    id: 'script-literal',
    scope,
    commandSegment: transcript('script-literal-segment', 2, 2.5, 'scratch that'),
    takes: [original],
    scriptText: 'For the demo, say scratch that exactly.',
  }), null);
});
