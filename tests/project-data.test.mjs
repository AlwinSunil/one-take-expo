import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, projectWithDurableOriginal, preserveEditsDuringCaptureFinalization } from '../src/lib/project-data.ts';
import { projectReview } from '../src/lib/project-workflow.ts';

test('legacy projects retain original media and trim and gain stable caption identity', () => {
  const old = { id: 'old', mode: 'script', videoUri: 'file:///original.mp4', trim: { start: 1, end: 4 }, transcript: [{ t0: 1, t1: 3, text: 'Hello' }], createdAt: 1 };
  const p = normalizeProject(old);
  assert.deepEqual(p.trim, old.trim);
  assert.equal(p.videoUri, old.videoUri);
  assert.equal(p.transcript[0].id, normalizeProject(old).transcript[0].id);
});
test('interrupted refinement preserves manual captions and becomes recoverable', () => {
  const p = normalizeProject({ id: 'one', mode: 'assisted', transcript: [{ t0: 0, t1: 1, text: 'corrected', correctedText: 'corrected' }], refinement: { status: 'running', model: 'tiny' } });
  assert.equal(p.refinement.status, 'failed');
  assert.equal(p.transcript[0].correctedText, 'corrected');
});
test('invalid metadata fails clearly and invalid timing cannot enter caption export', () => {
  assert.throws(() => normalizeProject({}), /identity/);
  assert.deepEqual(normalizeProject({ id: 'p', mode: 'assisted', transcript: [{ t0: -1, t1: 2, text: 'bad' }] }).transcript, []);
});

test('malformed action cues reject project metadata while valid cues remain safe for review', () => {
  const validCue = { id: 'keep', text: 'smile', required: true, resolved: false };
  const base = {
    id: 'bad-action-cue',
    mode: 'script',
    videoUri: null,
    clips: [],
    createdAt: 1,
    transcript: [],
    scriptLines: [{
      id: 'line-1',
      spokenText: 'hello',
      actionCues: [validCue],
    }],
  };

  const p = normalizeProject(base);
  assert.deepEqual(p.scriptLines[0].actionCues, [validCue]);
  const review = projectReview(p);
  assert.deepEqual(review.unresolvedRequiredActionCueIds, ['keep']);

  for (const malformedCue of [
    null,
    { text: 'wave', required: false, resolved: false },
    { id: 42, text: 'wave', required: false, resolved: false },
    { id: 'blank-text', text: '  ', required: false, resolved: false },
    { id: 'wrong-required', text: 'nod', required: 'yes', resolved: false },
    { id: 'wrong-resolved', text: 'nod', required: false, resolved: 0 },
  ]) {
    const project = {
      ...base,
      scriptLines: [{ ...base.scriptLines[0], actionCues: [validCue, malformedCue] }],
    };
    assert.throws(() => normalizeProject(project), /Project script lines are unreadable/);
  }
});

test('persisted take boundaries and action status survive normalization', () => {
  const take = { id: 'take-1', t0: 1, t1: 8, mediaUri: 'file:///take.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['s'], lineIds: ['line'] };
  const p = normalizeProject({ id: 'p', mode: 'script', transcript: [], takes: [take], pickupRequest: { lineIds: ['line'], requestedAt: 123 } });
  assert.deepEqual(p.takes, [take]);
  assert.deepEqual(projectReview(p).takes, [take]);
  assert.deepEqual(p.pickupRequest.lineIds, ['line']);
});

test('malformed persisted takes cannot supply coverage', () => {
  const base = { id: 'p', mode: 'script', transcript: [] };
  assert.throws(() => normalizeProject({ ...base, takes: [{ id: 'bad', t0: 4, t1: 2 }] }), /takes/);
  assert.throws(() => normalizeProject({ ...base, pickupRequest: { lineIds: 'line', requestedAt: 0 } }), /pickup/);
});

test('temporary missing media does not permanently change take playability', () => {
  const take = { id: 'take', t0: 0, t1: 1, mediaUri: 'file:///original.mp4', playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: [] };
  const p = normalizeProject({ id: 'p', mode: 'script', transcript: [], takes: [take], unavailableTakeIds: ['take'] });
  assert.equal(p.takes[0].playable, true);
  assert.equal(projectReview(p).takes[0].playable, false);
  assert.equal(projectReview({ ...p, unavailableTakeIds: [] }).takes[0].playable, true);
});


test('durable copy preserves explicit capture interruption but clears stale successful-save errors', () => {
  const interrupted = { id: 'p', mode: 'assisted', videoUri: 'file:///cache.mp4', transcript: [], clips: [], createdAt: 1,
    recordingStatus: 'interrupted', recoveryMessage: 'Recognition stopped unexpectedly. Review the saved original.' };
  const saved = projectWithDurableOriginal(interrupted, 'file:///durable.mp4');
  assert.equal(saved.videoUri, 'file:///durable.mp4');
  assert.equal(saved.recordingStatus, 'interrupted');
  assert.equal(saved.recoveryMessage, interrupted.recoveryMessage);
  assert.equal(normalizeProject(JSON.parse(JSON.stringify(saved))).recordingStatus, 'interrupted');
  const complete = projectWithDurableOriginal({ ...interrupted, recordingStatus: 'complete' }, 'file:///durable.mp4');
  assert.equal(complete.recordingStatus, 'complete');
  assert.equal(complete.recoveryMessage, undefined);
  assert.match(projectWithDurableOriginal({ ...interrupted, recoveryMessage: undefined }, 'file:///durable.mp4').recoveryMessage, /safely saved/);
});


test('late root capture finalization preserves edits made after its durable checkpoint', () => {
  const current = { id: 'p', mode: 'assisted', videoUri: 'file:///durable.mp4', clips: [], createdAt: 1,
    trim: { start: 1, end: 3 }, reviewDecisions: [{ id: 'manual', type: 'take-selection', takeId: 't' }],
    transcript: [{ id: 's', t0: 0, t1: 2, text: 'raw', manualCorrection: 'creator' }] };
  const captured = { ...current, videoUri: 'file:///cache.mp4', trim: undefined, reviewDecisions: [], transcript: [{ id: 's', t0: 0, t1: 2, text: 'final raw' }] };
  const merged = preserveEditsDuringCaptureFinalization(current, captured);
  assert.deepEqual(merged.trim, current.trim);
  assert.deepEqual(merged.reviewDecisions, current.reviewDecisions);
  assert.equal(merged.transcript[0].manualCorrection, 'creator');
  assert.equal(merged.transcript[0].text, 'final raw');
});
