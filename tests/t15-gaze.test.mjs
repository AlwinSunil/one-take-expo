import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAZE_SAMPLE_INTERVAL_MS,
  GAZE_MAX_OBSERVATIONS,
  createGazeCollector,
} from '../src/features/vision/gaze.ts';

const scope = (overrides = {}) => ({
  projectId: 'project-1',
  sourceId: 'source-1',
  takeId: 'take-1',
  captureSessionId: 'capture-1',
  visionSessionId: 'vision-1',
  generation: 'front-generation-1',
  lensFacing: 'front',
  previewMirrored: true,
  ...overrides,
});

function evidence(overrides = {}) {
  return {
    status: 'ready',
    sessionId: 'vision-1',
    lensFacing: 'front',
    engine: 'mlkit-face',
    processor: 'cpu-fallback',
    frameCapturedAtMs: 0,
    facePresence: 'present',
    faceStable: true,
    faces: [{ left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 }],
    ...overrides,
  };
}

test('emits source-scoped unknown gaze metadata with explicit unmirrored coordinates', () => {
  const collector = createGazeCollector(scope(), 1_000);

  collector.sample(1_025, evidence({
    frameCapturedAtMs: 1_020,
    facePresence: 'absent',
    faceStable: false,
    faces: [],
  }));

  const snapshot = collector.snapshot();
  assert.equal(snapshot.observations.length, 1);
  assert.deepEqual(snapshot.observations[0], {
    id: 'capture-1:front-generation-1:gaze-1',
    scope: scope(),
    relativeSeconds: 0.02,
    label: 'unknown',
    reason: 'no-face',
    confidence: null,
    uncertaintySeconds: null,
    provenance: {
      source: 'device',
      model: 'mlkit-face',
      modelVersion: '16.1.7',
      processor: 'cpu-fallback',
      coordinateSpace: 'upright-unmirrored',
      previewMirrored: true,
      clock: 'js-monotonic',
      clockAnchor: 'record-request',
      calibratedToMediaPts: false,
      bridgeLatency: 'unknown',
      sourceZeroMonotonicMs: 1_000,
    },
  });
});

test('marks a preview frame captured before the recording anchor as stale', () => {
  const collector = createGazeCollector(scope(), 1_000);

  collector.sample(1_025, evidence({ frameCapturedAtMs: 950 }));

  assert.equal(collector.snapshot().observations[0].reason, 'stale');
  assert.equal(collector.snapshot().observations[0].relativeSeconds, 0.025);
});

test('marks deterministic replay evidence explicitly so fixtures cannot look like camera evidence', () => {
  const collector = createGazeCollector(scope({ provenanceSource: 'fixture' }), 0);

  collector.sample(0, evidence({ frameCapturedAtMs: 0 }));

  assert.equal(collector.snapshot().observations[0].provenance.source, 'fixture');
});

test('samples at approximately one hertz and records delays as timestamped gaps', () => {
  const collector = createGazeCollector(scope(), 0);
  const current = evidence({ frameCapturedAtMs: 0 });

  collector.sample(0, current);
  collector.sample(400, current);
  collector.sample(2_500, evidence({ frameCapturedAtMs: 2_490 }));

  const observations = collector.snapshot().observations;
  assert.deepEqual(observations.map(observation => [observation.relativeSeconds, observation.reason]), [
    [0, 'unsupported-gaze-engine'],
    [1, 'sampling-gap'],
    [2.49, 'unsupported-gaze-engine'],
  ]);
  assert.equal(observations.filter(observation => observation.reason === 'sampling-gap').every(
    observation => observation.label === 'unknown' && observation.confidence === null,
  ), true);
});

test('does not turn ordinary one-second timer jitter into artificial gaps', () => {
  const collector = createGazeCollector(scope(), 0);

  collector.sample(0, evidence({ frameCapturedAtMs: 0 }));
  for (let index = 1; index <= 300; index += 1) {
    const nowMs = index * 1_001;
    collector.sample(nowMs, evidence({ frameCapturedAtMs: nowMs }));
  }

  const snapshot = collector.snapshot();
  assert.equal(snapshot.acceptedSampleCount, 301);
  assert.equal(snapshot.samplingGapCount, 0);
  assert.equal(snapshot.samplingGapOverflowSummary, null);
});

test('rejects evidence from another vision session or lens without advancing cadence', () => {
  const collector = createGazeCollector(scope(), 1_000);

  collector.sample(1_000, evidence({ frameCapturedAtMs: 1_000 }));
  collector.sample(1_500, evidence({ sessionId: 'old-vision', frameCapturedAtMs: 1_500 }));
  collector.sample(1_500, evidence({ lensFacing: 'back', frameCapturedAtMs: 1_500 }));
  collector.sample(2_000, evidence({ frameCapturedAtMs: 2_000 }));

  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.observations.map(observation => observation.relativeSeconds), [0, 1]);
  assert.equal(snapshot.rejectedEvidenceCount, 2);
  assert.equal(snapshot.observations.some(observation => observation.reason === 'sampling-gap'), false);
});

test('keeps five recording sessions independent and rejects stale evidence', () => {
  const sessions = Array.from({ length: 5 }, (_, index) => {
    const session = scope({
      captureSessionId: `capture-${index + 1}`,
      visionSessionId: `vision-${index + 1}`,
      takeId: `take-${index + 1}`,
      generation: `generation-${index + 1}`,
    });
    const collector = createGazeCollector(session, 10_000);
    collector.sample(10_000, evidence({ sessionId: session.visionSessionId, frameCapturedAtMs: 10_000 }));
    collector.sample(10_500, evidence({ sessionId: 'vision-previous', frameCapturedAtMs: 10_500 }));
    return collector.snapshot();
  });

  assert.equal(new Set(sessions.map(snapshot => snapshot.observations[0].scope.captureSessionId)).size, 5);
  assert.equal(sessions.every(snapshot => snapshot.observations.length === 1), true);
  assert.equal(sessions.every(snapshot => snapshot.rejectedEvidenceCount === 1), true);
});

test('uses explicit unknown reasons for no face, multiple faces, stale and unsupported evidence', () => {
  const collector = createGazeCollector(scope(), 0);

  collector.sample(0, evidence({ facePresence: 'absent', faces: [], frameCapturedAtMs: 0 }));
  collector.sample(GAZE_SAMPLE_INTERVAL_MS, evidence({
    facePresence: 'present',
    faces: [{ left: 0, top: 0, right: 1, bottom: 1 }, { left: 0, top: 0, right: 1, bottom: 1 }],
    frameCapturedAtMs: GAZE_SAMPLE_INTERVAL_MS,
  }));
  collector.sample(2 * GAZE_SAMPLE_INTERVAL_MS, evidence({
    frameCapturedAtMs: 2 * GAZE_SAMPLE_INTERVAL_MS - 2_000,
  }));
  collector.sample(3 * GAZE_SAMPLE_INTERVAL_MS, evidence({
    engine: 'none',
    frameCapturedAtMs: 3 * GAZE_SAMPLE_INTERVAL_MS,
  }));
  collector.sample(4 * GAZE_SAMPLE_INTERVAL_MS, evidence({
    lowLight: true,
    frameCapturedAtMs: 4 * GAZE_SAMPLE_INTERVAL_MS,
  }));
  collector.sample(5 * GAZE_SAMPLE_INTERVAL_MS, evidence({
    glasses: true,
    frameCapturedAtMs: 5 * GAZE_SAMPLE_INTERVAL_MS,
  }));
  collector.sample(6 * GAZE_SAMPLE_INTERVAL_MS, evidence({
    facePresence: 'unknown',
    frameCapturedAtMs: 6 * GAZE_SAMPLE_INTERVAL_MS,
  }));

  assert.deepEqual(collector.snapshot().observations.map(observation => observation.reason), [
    'no-face',
    'multiple-faces',
    'stale',
    'unsupported-gaze-engine',
    'unsupported-gaze-engine',
    'unsupported-gaze-engine',
    'unsupported-gaze-engine',
  ]);
});

test('stop flushes known cadence gaps and makes background/route-exit late samples inert', () => {
  const collector = createGazeCollector(scope(), 0);
  collector.sample(0, evidence({ frameCapturedAtMs: 0 }));

  collector.stop(2_250);
  const stopped = collector.snapshot();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.stoppedAtMonotonicMs, 2_250);
  assert.deepEqual(stopped.observations.map(observation => observation.reason), [
    'unsupported-gaze-engine',
    'sampling-gap',
    'sampling-gap',
  ]);

  collector.sample(3_000, evidence({ frameCapturedAtMs: 3_000 }));
  collector.stop(4_000);
  assert.deepEqual(collector.snapshot(), stopped);
});

test('bounds retention and reports dropped observations as a gap summary', () => {
  const collector = createGazeCollector(scope(), 0);

  for (let second = 0; second < GAZE_MAX_OBSERVATIONS + 5; second += 1) {
    collector.sample(second * GAZE_SAMPLE_INTERVAL_MS, evidence({ frameCapturedAtMs: second * GAZE_SAMPLE_INTERVAL_MS }));
  }

  const snapshot = collector.snapshot();
  assert.equal(snapshot.observations.length, GAZE_MAX_OBSERVATIONS);
  assert.equal(snapshot.droppedObservationCount, 5);
  assert.deepEqual(snapshot.retentionGapSummary, {
    count: 5,
    startRelativeSeconds: 0,
    endRelativeSeconds: 4,
  });
});

test('publishes every observation to the optional sink before retention can evict it', () => {
  const emitted = [];
  const collector = createGazeCollector(scope(), 0, { onObservation: observation => emitted.push(observation) });

  collector.sample(0, evidence({ frameCapturedAtMs: 0 }));
  collector.sample(2_500, evidence({ frameCapturedAtMs: 2_500 }));

  assert.deepEqual(emitted.map(observation => observation.reason), [
    'unsupported-gaze-engine',
    'sampling-gap',
    'unsupported-gaze-engine',
  ]);
  assert.equal(collector.snapshot().observations.length, emitted.length);
});

test('bounds gap replay work and reports omitted timestamp ranges', () => {
  const collector = createGazeCollector(scope(), 0);

  collector.sample(0, evidence({ frameCapturedAtMs: 0 }));
  collector.sample((GAZE_MAX_OBSERVATIONS + 5) * GAZE_SAMPLE_INTERVAL_MS, evidence({
    frameCapturedAtMs: (GAZE_MAX_OBSERVATIONS + 5) * GAZE_SAMPLE_INTERVAL_MS,
  }));

  const snapshot = collector.snapshot();
  assert.equal(snapshot.samplingGapCount, GAZE_MAX_OBSERVATIONS + 4);
  assert.deepEqual(snapshot.samplingGapOverflowSummary, {
    count: 4,
    startRelativeSeconds: 1,
    endRelativeSeconds: 4,
  });
});

test('a failing metadata sink is isolated from sampling and reported in diagnostics', () => {
  const collector = createGazeCollector(scope(), 0, () => {
    throw new Error('metadata store unavailable');
  });

  assert.doesNotThrow(() => collector.sample(0, evidence({ frameCapturedAtMs: 0 })));
  assert.equal(collector.snapshot().acceptedSampleCount, 1);
  assert.equal(collector.snapshot().sinkFailureCount, 1);
});
