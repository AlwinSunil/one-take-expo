import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCleanupPlan,
  applyCleanupDecision,
} from '../src/features/speech-control/cleanup.ts';
import {
  createMustSayMetadata,
  setMustSayEnabled,
} from '../src/features/speech-control/must-say.ts';
import {
  createTake,
  createTakeDecisionState,
  createVoiceScratchEvent,
  deriveTakeReasons,
  flagTake,
  reduceTakeDecision,
} from '../src/features/speech-control/take-decisions.ts';
import {
  T1_SPEECH_PROVIDER_VERSION,
  adaptT1SpeechProviderEnvelope,
} from '../src/lib/t1-speech-provider.ts';

const projectId = 'speech-provider-fixture';
const sourceId = 'recording-1';
const mediaUri = 'file:///captures/recording-1.mp4';
const scope = { sessionId: 'capture-1', sourceId };
const currentScript = [
  { lineId: 'line-1', spokenText: 'Our bottle stays cold.' },
  { lineId: 'line-2', spokenText: 'Try it today.' },
];

function metadataForCurrentScript() {
  const metadata = createMustSayMetadata(currentScript.map((line) => ({
    id: line.lineId,
    text: line.spokenText,
    spokenText: line.spokenText,
  })));
  return setMustSayEnabled(metadata, 'line-1', true);
}

function rawSegment(id, text, t0 = 0.5, t1 = 2) {
  return {
    id,
    sessionId: scope.sessionId,
    sourceId,
    t0,
    t1,
    text,
    isFinal: true,
    state: 'final',
    commandContext: 'standalone',
    quality: 'clear',
  };
}

function speechSegment(id, text, overrides = {}) {
  return {
    id,
    text,
    isFinal: true,
    t0: 0.5,
    t1: 2,
    takeId: 'take-1',
    lineIds: ['line-1'],
    requirementRevisions: { 'line-1': 0, 'line-2': 0 },
    playable: true,
    mediaUri,
    quality: 'clean',
    ...overrides,
  };
}

function takeState(overrides = {}) {
  const raw = rawSegment('raw-1', 'Our bottle stays cold.');
  const take = createTake({
    id: 'take-1',
    scope,
    attempt: 0,
    t0: 0,
    t1: 3,
    lineIds: ['line-1'],
    transcriptSegments: [raw],
    verdict: 'clean',
    ...overrides,
  });
  return createTakeDecisionState({ scope, takes: [take] });
}

function cleanupSnapshot() {
  const segments = [{
    id: 'cleanup-speech-1',
    recordingId: sourceId,
    t0: 0.5,
    t1: 2,
    text: 'Our bottle stays cold.',
    isFinal: true,
  }];
  const marks = [{
    id: 'filler-1',
    recordingId: sourceId,
    kind: 'filler',
    text: 'uh',
    isMidSentence: false,
    t0: 2.1,
    t1: 2.3,
    startBoundary: { source: 'manual-review', verified: true },
    endBoundary: { source: 'manual-review', verified: true },
  }];
  const initial = createCleanupPlan({ recordingId: sourceId, segments, marks });
  const decisions = applyCleanupDecision([], initial.suggestions[0], 'accept');
  return createCleanupPlan({ recordingId: sourceId, segments, marks, decisions });
}

function baseEnvelope(overrides = {}) {
  return {
    version: T1_SPEECH_PROVIDER_VERSION,
    projectId,
    provider: 'integrated',
    revision: 'speech-r1',
    status: 'available',
    scriptSnapshot: structuredClone(currentScript),
    capture: {
      recordings: [{
        recordingId: sourceId,
        mediaUri,
        duration: 4,
        mediaAvailable: true,
      }],
      takeDecisions: [takeState()],
      firstTakeStartedAt: 1000,
      wrapRequestedAt: 8000,
    },
    mustSay: {
      metadata: metadataForCurrentScript(),
      segments: [speechSegment('speech-1', 'Our bottle stays cold.')],
      recognitionStatus: 'ready',
      mediaAvailable: true,
    },
    cleanup: [{ recordingId: sourceId, plan: cleanupSnapshot() }],
    ...overrides,
  };
}

function adapt(envelope = baseEnvelope(), context = { projectId, scriptSnapshot: currentScript }) {
  return adaptT1SpeechProviderEnvelope(envelope, context);
}

test('the merged producers adapt to Tier1 evidence while preserving IDs, raw wording, timing, and cleanup decisions', () => {
  const result = adapt();

  assert.equal(result.ok, true);
  assert.equal(result.evidence.projectId, projectId);
  assert.equal(result.evidence.provider, 'integrated');
  assert.equal(result.evidence.revision, 'speech-r1');
  assert.equal(result.evidence.status, 'available');
  assert.deepEqual(result.evidence.scriptSnapshot, currentScript);
  assert.deepEqual(result.evidence.firstTakeStartedAt, 1000);
  assert.deepEqual(result.evidence.wrapRequestedAt, 8000);
  assert.deepEqual(result.evidence.mustSay, [
    {
      lineId: 'line-1',
      required: true,
      status: 'satisfied',
      evidence: [{ recordingId: sourceId, t0: 0.5, t1: 2 }],
    },
    {
      lineId: 'line-2',
      required: false,
      status: 'satisfied',
      evidence: [],
    },
  ]);
  assert.equal(result.evidence.cleanup.length, 1);
  assert.equal(result.evidence.cleanup[0].suggestionId, 'filler:filler-1');
  assert.equal(result.evidence.cleanup[0].state, 'removed');
  assert.equal(result.evidence.cleanup[0].boundariesReviewed, true);
  assert.equal(result.evidence.cleanup[0].footage.recordingId, sourceId);
  assert.equal(result.evidence.cleanup[0].footage.t0, 2.1);
  assert.equal(result.evidence.cleanup[0].footage.t1, 2.3);
});

test('producer reasons are carried as supplied and point to the durable take interval', () => {
  const raw = rawSegment('raw-flub', 'Our bottle stays');
  const original = createTake({
    id: 'take-flagged',
    scope,
    t0: 0,
    t1: 3,
    lineIds: ['line-1'],
    transcriptSegments: [raw],
    verdict: 'clean',
  });
  const reasons = deriveTakeReasons({
    take: original,
    scriptLines: [{ lineId: 'line-1', text: 'Our bottle stays cold.' }],
    transcriptSegments: [raw],
  });
  const flagged = flagTake(original, reasons);
  const envelope = baseEnvelope({
    capture: {
      ...baseEnvelope().capture,
      takeDecisions: [createTakeDecisionState({ scope, takes: [flagged] })],
    },
    mustSay: {
      ...baseEnvelope().mustSay,
      segments: [speechSegment('speech-1', 'Our bottle stays cold.', { takeId: 'take-flagged' })],
    },
  });

  const result = adapt(envelope);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence.reasons.map(({ id, takeId, message, status, footage }) => ({
    id,
    takeId,
    message,
    status,
    footage,
  })), reasons.map((reason) => ({
    id: reason.id,
    takeId: reason.takeId,
    message: reason.message,
    status: reason.status,
    footage: { recordingId: sourceId, t0: 0, t1: 3 },
  })));
});

test('voice scratch preserves the producer command segment and applied state', () => {
  const state = takeState();
  const command = {
    id: 'command-1',
    sessionId: scope.sessionId,
    sourceId,
    t0: 3.1,
    t1: 3.6,
    text: 'scratch that',
    isFinal: true,
    state: 'final',
    commandContext: 'standalone',
    quality: 'clear',
  };
  const event = createVoiceScratchEvent({
    id: 'scratch-voice-1',
    scope,
    commandSegment: command,
    takes: state.takes,
  });
  assert.ok(event);
  const scratched = reduceTakeDecision(state, event);
  const envelope = baseEnvelope({
    capture: {
      ...baseEnvelope().capture,
      takeDecisions: [scratched],
    },
  });

  const result = adapt(envelope);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence.scratchHistory, [{
    id: 'scratch-voice-1',
    takeId: 'take-1',
    commandSegmentId: 'command-1',
    source: 'voice',
    state: 'applied',
  }]);
});

test('manual scratch preserves its explicit source and null command segment', () => {
  const state = takeState();
  const manual = {
    id: 'scratch-manual-1',
    type: 'scratch',
    scope,
    takeId: 'take-1',
    source: 'manual',
    commandSegmentId: null,
    commandInterval: null,
  };
  const envelope = baseEnvelope({
    capture: {
      ...baseEnvelope().capture,
      takeDecisions: [createTakeDecisionState({ scope, takes: state.takes, events: [manual] })],
    },
  });

  const result = adapt(envelope);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence.scratchHistory, [{
    id: 'scratch-manual-1',
    takeId: 'take-1',
    commandSegmentId: null,
    source: 'manual',
    state: 'applied',
  }]);
});

test('old requirement revisions remain unresolved instead of being stamped with current metadata', () => {
  const metadata = metadataForCurrentScript();
  metadata.requirements[0].revision = 1;
  const result = adapt(baseEnvelope({
    mustSay: {
      ...baseEnvelope().mustSay,
      metadata,
      segments: [speechSegment('old-speech', 'Our bottle stays cold.', {
        requirementRevisions: { 'line-1': 0, 'line-2': 0 },
      })],
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.evidence.mustSay[0].status, 'missing');
  assert.deepEqual(result.evidence.mustSay[0].evidence, [{
    recordingId: sourceId,
    t0: 0.5,
    t1: 2,
  }]);
});

test('pending media and recognition stay honest and never become covered', () => {
  const result = adapt(baseEnvelope({
    status: 'pending',
    capture: {
      ...baseEnvelope().capture,
      recordings: [{
        recordingId: sourceId,
        mediaUri: null,
        duration: 4,
        mediaAvailable: false,
      }],
    },
    mustSay: {
      ...baseEnvelope().mustSay,
      segments: [speechSegment('pending-speech', 'Our bottle stays cold.', {
        playable: false,
        mediaUri: null,
        isFinal: false,
      })],
      recognitionStatus: 'listening',
      mediaAvailable: false,
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, 'pending');
  assert.equal(result.evidence.mustSay[0].status, 'pending');
  assert.equal(result.evidence.mustSay[0].evidence.length, 1);
});

test('project, script, source, and payload mismatches fail closed', () => {
  const cases = [
    [baseEnvelope({ projectId: 'other-project' }), { projectId, scriptSnapshot: currentScript }, 'project-mismatch'],
    [baseEnvelope(), { projectId, scriptSnapshot: [{ lineId: 'line-1', spokenText: 'Changed wording.' }, currentScript[1]] }, 'script-mismatch'],
    [baseEnvelope({ capture: { ...baseEnvelope().capture, recordings: [] } }), undefined, 'missing-provenance'],
    [baseEnvelope({ version: 99 }), undefined, 'malformed'],
  ];

  for (const [envelope, context, code] of cases) {
    const result = adapt(envelope, context ?? { projectId, scriptSnapshot: currentScript });
    assert.equal(result.ok, false, code);
    assert.equal(result.error.code, code, code);
  }
});

test('missing segment provenance fails closed instead of inferring a take or requirement revision', () => {
  const missingTakeId = adapt(baseEnvelope({
    mustSay: {
      ...baseEnvelope().mustSay,
      segments: [speechSegment('missing-take', 'Our bottle stays cold.', { takeId: undefined })],
    },
  }));
  assert.equal(missingTakeId.ok, false);
  assert.equal(missingTakeId.error.code, 'missing-provenance');

  const missingRevision = adapt(baseEnvelope({
    mustSay: {
      ...baseEnvelope().mustSay,
      segments: [speechSegment('missing-revision', 'Our bottle stays cold.', {
        requirementRevisions: { 'line-1': 0 },
      })],
    },
  }));
  assert.equal(missingRevision.ok, false);
  assert.equal(missingRevision.error.code, 'missing-provenance');
});
