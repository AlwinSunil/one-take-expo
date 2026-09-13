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
