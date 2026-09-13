import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptPointChecks, projectPointChecks } from '../src/features/capture/script-point-checks.ts';
import { parseScript } from '../src/lib/script-lines.ts';
import { captureScriptLines } from '../src/features/capture/coverage.ts';
const doc = parseScript('The camera records offline. We save twelve videos. [Smile]');
const a = { id: 'a', text: 'The camera records offline.', t0: 0, t1: 2, isFinal: true };
const b = { id: 'b', text: 'We save twelve videos.', t0: 3, t1: 5, isFinal: true };
const project = { id: 'p', mode: 'script', script: doc.text, scriptLines: captureScriptLines(doc),
  videoUri: 'file:///original.mp4', transcript: [a, b], duration: 6, clips: [], createdAt: 1 };
test('on-device checks find missing spoken points and exclude action cues', () => {
  const checks = scriptPointChecks(doc, [a]);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, 'covered');
  assert.notEqual(checks[1].status, 'covered');
});
test('changed facts, unfinished recognition and unavailable analysis do not pass', () => {
  assert.notEqual(scriptPointChecks(doc, [{ ...b, text: 'We save twenty videos.' }])[1].status, 'covered');
  assert.notEqual(scriptPointChecks(doc, [{ ...a, isFinal: false }])[0].status, 'covered');
  assert.equal(scriptPointChecks(doc, [], false)[0].status, 'unavailable');
});
test('points removed by a retake are flagged against the actual kept video', () => {
  const checks = projectPointChecks({ ...project, cuts: [{ t0: 0, t1: 2 }], cutsReviewed: true });
  assert.equal(checks[0].status, 'covered');
  assert.notEqual(checks[1].status, 'covered');
  assert.ok(projectPointChecks(project).every(point => point.status === 'covered'));
});
test('a kept replacement restores the point while the scratched source stays excluded', () => {
  const next = { ...project, transcript: [a, b, { ...b, id: 'retry', recordingId: 'pickup' }],
    recordings: [{ id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 6, createdAt: 2 }],
    reviewSegments: [{ uri: project.videoUri, t0: 0, t1: 2 }, { uri: 'file:///pickup.mp4', t0: 3, t1: 5 }] };
  assert.ok(projectPointChecks(next).every(point => point.status === 'covered'));
});

test('local importance selection accepts no important points and ignores a stale script analysis', () => {
  const scriptAnalysis = { script: project.script, importantLineIds: [], model: 'Qwen3 0.6B' };
  assert.deepEqual(projectPointChecks({ ...project, scriptAnalysis }), []);
  assert.equal(projectPointChecks({ ...project, scriptAnalysis: { ...scriptAnalysis, script: 'Old script' } }).length, 2);
});

test('semantic paraphrase coverage requires retained final current speech from available media', () => {
  const segment = { ...a, text: 'No connection is needed to film.' };
  const semanticMatches = [{ segmentId: a.id, text: segment.text, lineId: project.scriptLines[0].id, verdict: 'complete' }];
  const next = { ...project, transcript: [segment, b], semanticMatches };
  assert.equal(projectPointChecks(next)[0].status, 'covered');
  for (const variant of [
    { ...next, cuts: [{ t0: 3, t1: 5 }] },
    { ...next, mediaMissing: true },
    { ...next, transcript: [{ ...segment, isFinal: false }, b] },
    { ...next, transcript: [{ ...segment, needsListening: true }, b] },
    { ...next, transcript: [{ ...segment, manualCorrection: 'A connection is needed to film.' }, b] },
  ]) assert.notEqual(projectPointChecks(variant)[0].status, 'covered');
});

test('filler removal preserves semantic coverage but removing a claim word invalidates it', () => {
  const segment = { ...a, text: 'Um no connection needed', words: [
    { text: 'Um', t0: 0, t1: 0.2 }, { text: 'no', t0: 0.3, t1: 0.5 },
    { text: 'connection', t0: 0.6, t1: 1.2 }, { text: 'needed', t0: 1.3, t1: 2 },
  ] };
  const next = { ...project, transcript: [segment], semanticMatches: [{ segmentId: a.id, text: segment.text, lineId: project.scriptLines[0].id, verdict: 'complete' }],
    reviewSegments: [{ uri: project.videoUri, t0: 0.3, t1: 2 }] };
  assert.equal(projectPointChecks(next)[0].status, 'covered');
  assert.notEqual(projectPointChecks({ ...next, reviewSegments: [{ uri: project.videoUri, t0: 0.6, t1: 2 }] })[0].status, 'covered');
});

test('final review recognizes a sentence split over adjacent speech utterances', () => {
  const next = { ...project, transcript: [
    { id: 'first', text: 'The camera', t0: 0, t1: 1, isFinal: true },
    { id: 'second', text: 'records offline.', t0: 1, t1: 2, isFinal: true },
  ] };
  assert.equal(projectPointChecks(next)[0].status, 'covered');
});
