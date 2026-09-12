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
