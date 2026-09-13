import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createGazeCollector } from '../src/features/vision/gaze.ts';
import { createSuggestionJobController } from '../src/features/coach/suggestion-job.ts';

const sessions = [];
for (let index = 0; index < 5; index++) {
  const sessionId = `fixture:session:${index}`;
  const identity = { sessionId, lensGeneration: `fixture:binding:${index}`, intent: 'talking-head' };
  const gaze = createGazeCollector({ projectId: `fixture:project:${index}`, sourceId: `fixture:source:${index}`,
    takeId: `fixture:take:${index}`, captureSessionId: sessionId, visionSessionId: identity.lensGeneration,
    generation: identity.lensGeneration, lensFacing: 'front', previewMirrored: true, provenanceSource: 'fixture' }, 0);
  const jobs = createSuggestionJobController();
  jobs.bind(identity);
  const before = jobs.getDiagnostics();
  assert.equal(before.starts, 0);
  const sourceTimes = [];
  for (let second = 0; second < 30; second++) {
    const timeMs = second * 1001;
    const observed = gaze.sample(timeMs, { status: 'ready', sessionId: identity.lensGeneration,
      lensFacing: 'front', engine: 'mlkit-face', processor: 'cpu-fallback', frameCapturedAtMs: timeMs,
      facePresence: second % 10 === 0 ? 'absent' : 'present', faceStable: true,
      faces: second % 10 === 0 ? [] : [{ left: .2, top: .2, right: .8, bottom: .8 }] });
    if (observed) sourceTimes.push(observed.relativeSeconds);
  }
  jobs.start({ ...identity, requestedAtMs: 30000, evidence: { status: 'ready', frameCapturedAtMs: 30000, observations: {} } });
  await jobs.whenSettled();
  assert.equal(jobs.getSnapshot().status, 'unavailable');
  const after = jobs.getDiagnostics();
  jobs.bind(identity);
  await Promise.resolve();
  assert.equal(jobs.getDiagnostics().starts, 1);
  assert.equal(jobs.getDiagnostics().evaluations, 1);
  const snapshot = gaze.stop(30000);
  assert.equal(snapshot.observations.every(item => item.label === 'unknown'), true);
  assert.equal(snapshot.samplingGapCount, 0);
  sessions.push({ sessionId, mode: index % 2 ? 'script' : 'assisted', sourceTimes,
    simulatedCadenceSeconds: sourceTimes.slice(1).map((time, i) => Number((time - sourceTimes[i]).toFixed(3))),
    acceptedSamples: snapshot.acceptedSampleCount, gapCount: snapshot.samplingGapCount,
    labels: { unknown: snapshot.observations.length }, suggestionJobs: { before, after },
    result: jobs.getSnapshot().status });
}
const output = { version: 1, provenance: 'deterministic fixture replay on host CPU; no camera inference',
  clock: 'synthetic milliseconds converted to source-relative seconds', sessions,
  deviceAcceptance: { gazeConfusion: 'pending', measuredCadence: 'pending', batteryThermalRecordingImpact: 'pending',
    accessibility: 'pending', namedHumanReview: 'pending' } };
const json = JSON.stringify(output, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], json);
else process.stdout.write(json);
