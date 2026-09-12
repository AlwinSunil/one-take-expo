import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../src/lib/project-data.ts';
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
