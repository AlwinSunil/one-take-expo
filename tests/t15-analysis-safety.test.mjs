import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalAnalysis, analyzeFinalTake } from '../src/features/speech-analysis/final-analysis.ts';
const scope = { projectId: 'p', sourceId: 's', scriptRevision: 'script1', editRevision: 'edit1', transcriptRevision: 'transcript1' };
const span = (id, text, order) => ({ id, lineId: id, text, order, start: 0, end: text.length, scriptRevision: scope.scriptRevision });
const a = 'We record the introduction.';
const b = 'We explain the camera.';
const obs = (id, text, t0, t1, extra = {}) => ({ id, text, t0, t1, sourceId: 's', takeId: `take:${id}`, isFinal: true, provenance: 'manual-review', verifiedBoundary: true, uncertaintySeconds: null, ...extra });
test('a related whole utterance retains unique adjacent content even when its confidence is weaker', () => {
  const result = createFinalAnalysis({ scope, jobId: 'whole', sourceDuration: 10, scriptSpans: [span('a', a, 0), span('b', b, 1)], observations: [obs('a', a, 0, 2, { confidence: 0.95 }), obs('ab', `${a} ${b}`, 4, 8, { confidence: 0.55 })] });
  assert.ok(result.rangeProposal.ranges.filter(range => range.observationIds.includes('ab')).every(range => range.disposition === 'retained'));
});
test('overlapping observations from distinct take identities cannot produce an unsafe exclusion', () => {
  const result = createFinalAnalysis({ scope, jobId: 'overlap', sourceDuration: 10, scriptSpans: [span('a', a, 0)], observations: [obs('strong', a, 0, 3, { confidence: 0.95 }), obs('weak', a, 2, 4, { confidence: 0.55 })] });
  assert.ok(result.rangeProposal.ranges.every(range => range.disposition === 'retained'));
});
test('full transcript survives the live UI segment cap and all source gaps remain retained', () => {
  const observations = Array.from({ length: 270 }, (_, index) => obs(`u${index}`, `Observation number ${index} is available.`, index * 2, index * 2 + 1));
  const result = createFinalAnalysis({ scope, jobId: 'long', sourceDuration: 540, observations });
  assert.equal(result.transcriptHistory.length, 270);
  assert.equal(result.transcriptHistory.at(-1).id, 'u269');
  assert.ok(result.rangeProposal.ranges.every(range => range.disposition === 'retained'));
  assert.equal(result.rangeProposal.ranges.reduce((sum, range) => sum + range.t1 - range.t0, 0), 540);
});
test('default async checkpoints let an event-loop cancellation run', async () => {
  const control = { aborted: false };
  setTimeout(() => { control.aborted = true; }, 0);
  const result = await analyzeFinalTake({ scope, jobId: 'cancel', sourceDuration: 5, observations: [obs('a', a, 0, 2)] }, { signal: control });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rangeProposal, null);
});
test('explicit revision chains are arrival-order independent and cycles are rejected', () => {
  const old = obs('old', a, 0, 2, { takeId: 'same' });
  const corrected = obs('corrected', 'We do not record the introduction.', 0, 2, { takeId: 'same', revisionOf: 'old' });
  for (const observations of [[old, corrected], [corrected, old]]) {
    const result = createFinalAnalysis({ scope, jobId: 'chain', sourceDuration: 5, scriptSpans: [span('a', a, 0)], observations });
    assert.equal(result.attempts[0].text, corrected.text);
    assert.equal(result.recommendedAttemptId, null);
  }
  assert.throws(() => createFinalAnalysis({ scope, jobId: 'cycle', sourceDuration: 5, observations: [{ ...old, revisionOf: 'corrected' }, corrected] }), /cyclic/);
});
test('a newer provisional revision cannot borrow a previous final verdict', () => {
  const result = createFinalAnalysis({ scope, jobId: 'revised-partial', sourceDuration: 5, scriptSpans: [span('a', a, 0)], observations: [obs('old', a, 0, 2, { takeId: 'same', utteranceId: 'u', revision: 1 }), obs('new', 'We record', 0, 2, { takeId: 'same', utteranceId: 'u', revision: 2, isFinal: false })] });
  assert.equal(result.recommendedAttemptId, null);
  assert.equal(result.attempts[0].state, 'provisional');
});
