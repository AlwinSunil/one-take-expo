import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRetakeEdit, resolveManualScratch, resolveVoiceScratches } from '../src/features/capture/voice-scratch.ts';
import { captureScriptLines, deriveCaptureCoverage } from '../src/features/capture/coverage.ts';
import { parseScript } from '../src/lib/script-lines.ts';
import { createTranscriptSegment } from '../src/lib/transcript-workflow.ts';
import { cleanReview, selectedReviewSegments } from '../src/lib/clean-review.ts';
import { mergePickupRecording, normalizeProject } from '../src/lib/project-data.ts';

const document = parseScript('Welcome to the show. Let us get started.');
const lines = captureScriptLines(document);
const segment = (id, text, t0, isFinal = true) => createTranscriptSegment({ id, text, t0, t1: t0 + 1, isFinal });
const first = segment('first', 'Welcome to the show.', 0);
const second = segment('second', 'Let us get started.', 2);
const command = segment('command', 'Scratch that!', 4);
const replacement = segment('replacement', 'Let us get started.', 6);

test('scratches only the preceding attempt and excludes the standalone command', () => {
  const result = resolveVoiceScratches([first, second, command, replacement], lines);
  assert.deepEqual([...result.excluded], ['command', 'second']);
  assert.equal(result.actions[0].lineId, lines[1].id);
});
test('partial commands, quoted phrases and script dialogue never become commands', () => {
  for (const candidate of [{ ...command, isFinal: false }, { ...command, text: 'I said scratch that yesterday.' }]) {
    assert.equal(resolveVoiceScratches([first, candidate], lines).actions.length, 0);
  }
  assert.equal(resolveVoiceScratches([first, command], captureScriptLines(parseScript('Please say scratch that.'))).actions.length, 0);
});
test('replayed events and repeated commands do not scratch earlier lines', () => {
  const repeated = segment('again', 'scratch that', 5);
  const result = resolveVoiceScratches([first, second, command, command, repeated], lines);
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[1].reason, 'no-target');
  assert.equal(result.excluded.has(first.id), false);
});
test('waits for preceding recognition to finalize and refuses overlapping or multi-line targets', () => {
  assert.equal(resolveVoiceScratches([{ ...second, isFinal: false }, command], lines).actions[0].reason, 'pending');
  assert.equal(resolveVoiceScratches([second, command], lines).actions[0].reason, 'scratched');
  assert.equal(resolveVoiceScratches([{ ...second, t1: 4.5 }, command], lines).actions[0].reason, 'ambiguous');
  const merged = segment('merged', 'Welcome to the show. Let us get started.', 0);
  assert.equal(resolveVoiceScratches([merged, command], lines).actions[0].reason, 'ambiguous');
});
function projectFor(transcript) {
  const coverage = deriveCaptureCoverage({ document, takeId: 'capture', videoUri: 'file:///original.mp4', transcript, voiceCommands: true });
  const actions = resolveVoiceScratches(transcript, lines).actions;
  const edit = captureRetakeEdit(8, actions.map(action => ({ t0: action.startedAt, t1: action.endedAt })));
  return { ...edit, id: 'project', mode: 'script', script: document.text, scriptLines: lines,
    transcript, takes: coverage.review.takes, videoUri: 'file:///original.mp4', duration: 8, createdAt: 1, clips: [] };
}
test('saved and reopened clean sequence excludes scratch and command, includes replacement, preserves original', () => {
  const project = normalizeProject(JSON.parse(JSON.stringify(projectFor([first, second, command, replacement]))));
  const sequence = selectedReviewSegments(project, cleanReview(project));
  assert.deepEqual(sequence.segments.map(({ t0, t1 }) => [t0, t1]), [[0, 1], [6, 7]]);
  assert.equal(project.transcript.length, 4);
  assert.equal(project.videoUri, 'file:///original.mp4');
  assert.equal(project.takes.find(take => take.transcriptSegmentIds.includes('second')).quality, 'scratched');
});
test('repeated separate readings select one synchronized source interval', () => {
  const project = projectFor([first, second, replacement]);
  assert.deepEqual(selectedReviewSegments(project).segments.map(({ t0, t1 }) => [t0, t1]), [[0, 1], [6, 7]]);
});
test('a scratch without a replacement leaves that script line needed', () => {
  assert.equal(cleanReview(projectFor([first, second, command])).lines[1].status, 'needed');
});
test('pickup namespacing retains scratch exclusions and leaves earlier source intact', () => {
  const original = projectFor([first]);
  const pickup = projectFor([second, command, replacement]);
  const merged = mergePickupRecording(original, 'pickup', { videoUri: 'file:///pickup.mp4', duration: 8,
    transcript: pickup.transcript, takes: pickup.takes.map(take => ({ ...take, mediaUri: 'file:///pickup.mp4' })) }, 20);
  const sequence = selectedReviewSegments(merged);
  assert.deepEqual(sequence.segments.map(({ uri, t0, t1 }) => [uri, t0, t1]), [['file:///original.mp4', 0, 1], ['file:///pickup.mp4', 6, 7]]);
});
test('an acknowledged live command remains effective if stop truncates its interval', () => {
  const coverage = deriveCaptureCoverage({ document, takeId: 'capture', videoUri: 'file:///original.mp4',
    transcript: [first, second, { ...command, isFinal: false }], voiceCommands: true, excludedSegmentIds: ['command', 'second'] });
  assert.equal(coverage.review.lines[1].status, 'needed');
  assert.equal(coverage.review.takes[1].quality, 'scratched');
});

test('regression: scratching must change the default export, not only best-take metadata', async () => {
  const { buildExportPlan } = await import('../src/lib/export-plan.ts');
  const project = projectFor([first, second, command, replacement]);
  const plan = buildExportPlan(project, 0, 8, false, false);
  assert.deepEqual(plan.cuts, [{ t0: 0, t1: 2 }, { t0: 5, t1: 8 }]);
});

test('volume-down removes just the last fumble, including an in-progress utterance', () => {
  const action = resolveManualScratch([first, { ...second, isFinal: false }], lines, 3.5, new Set());
  assert.equal(action.targetId, second.id);
  const edit = captureRetakeEdit(8, [{ t0: action.startedAt, t1: action.endedAt }]);
  assert.deepEqual(edit, { cuts: [{ t0: 0, t1: 2 }, { t0: 3.5, t1: 8 }], cutsReviewed: true });
  assert.equal(resolveManualScratch([first, second], lines, 3.6, new Set([second.id])).reason, 'no-target');
});
test('retake cuts align speech to video clocks and merge overlapping removals', () => {
  assert.deepEqual(captureRetakeEdit(8, [{ t0: 3, t1: 5 }, { t0: 4, t1: 7 }], 1).cuts,
    [{ t0: 0, t1: 2 }, { t0: 6, t1: 8 }]);
  assert.deepEqual(captureRetakeEdit(8, []).cuts, undefined);
  assert.deepEqual(captureRetakeEdit(8, [{ t0: 0, t1: 10 }]).cuts, []);
});
test('saved default exports and pickup exports retain the explicit video/audio removal', async () => {
  const { buildExportPlan } = await import('../src/lib/export-plan.ts');
  const original = normalizeProject(JSON.parse(JSON.stringify(projectFor([first, second, command, replacement]))));
  assert.deepEqual(buildExportPlan(original, 0, 8, false, false).cuts, [{ t0: 0, t1: 2 }, { t0: 5, t1: 8 }]);
  const merged = mergePickupRecording(original, 'retry', { videoUri: 'file:///retry.mp4', duration: 8,
    transcript: [], takes: [], captureCuts: [{ t0: 3, t1: 8 }] }, 20);
  assert.equal(merged.cutsReviewed, true);
  assert.deepEqual(buildExportPlan(merged, 0, 8, false, false).segments.map(({ uri, t0, t1 }) => ({ uri, t0, t1 })),
    [{ uri: original.videoUri, t0: 0, t1: 2 }, { uri: original.videoUri, t0: 5, t1: 8 }, { uri: 'file:///retry.mp4', t0: 3, t1: 8 }]);
  const another = mergePickupRecording(merged, 'next', { videoUri: 'file:///next.mp4', duration: 2, transcript: [], takes: [] }, 30);
  assert.equal(buildExportPlan(another, 0, 8, false, false).segments.length, 4);
});
test('a pending pickup checkpoint cannot resurrect footage removed from an earlier recording', async () => {
  const { buildExportPlan } = await import('../src/lib/export-plan.ts');
  const original = projectFor([first, second, command, replacement]);
  const firstPickup = mergePickupRecording(original, 'first-pickup', { videoUri: 'file:///first-pickup.mp4', duration: 8,
    transcript: [], takes: [], captureCuts: [{ t0: 3, t1: 8 }] }, 20);
  const pending = mergePickupRecording(firstPickup, 'second-pickup', { videoUri: 'file:///second-pickup.mp4', duration: 8,
    transcript: [], takes: [], evidenceStatus: 'pending' }, 30);
  assert.deepEqual(pending.reviewSegments, firstPickup.reviewSegments);
  const completed = mergePickupRecording(pending, 'second-pickup', { videoUri: 'file:///second-pickup.mp4', duration: 8,
    transcript: [], takes: [], evidenceStatus: 'complete' }, 30);
  const plan = buildExportPlan(completed, 0, 8, false, false);
  assert.deepEqual(plan.segments.slice(0, 3).map(({ uri, t0, t1 }) => ({ uri, t0, t1 })), firstPickup.reviewSegments);
});
