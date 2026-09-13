import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTEGRATED_FRAMING_FIELD_GAPS,
  integrateFramingFixture,
  integrateProducerFraming,
} from '../src/lib/t1-framing-integrated.ts';
import { FRAMING_FIXTURES } from '../src/features/vision/framing-fixtures.ts';

test('actual portrait producer fixture validates and fails closed at the consumer proof seam', () => {
  const result = integrateFramingFixture('portrait-talking-head', { enabled: true });

  assert.equal(result.requestValidation.valid, true);
  assert.equal(result.tracksValidation.valid, true);
  assert.equal(result.producerValidation.valid, true);
  assert.equal(result.producerSuggestion.originalFrameFallback, false);
  assert.equal(result.producerSuggestion.sourceMediaId, result.request.sourceMediaId);
  assert.equal(result.producerSuggestion.takeId, result.request.takeId);
  assert.equal(result.producerSuggestion.analysisId, result.request.analysisId);
  assert.equal(result.producerSuggestion.analysisRevision, result.request.analysisRevision);
  assert.equal(result.consumer.ok, false);
  assert.equal(result.consumer.error.code, 'missing-proof');
  assert.equal(result.consumer.suggestion.mode, 'original');
  assert.deepEqual(result.remainingFieldGaps.map(gap => gap.field), [
    'coverage',
    'movement',
    'protectedRegions',
    'unionProof',
    'captionSafeArea',
  ]);
});

test('actual moving and product fixtures remain original without inferred completeness or movement', () => {
  for (const fixtureId of ['moving-vlog-subject', 'product-demo-with-hands']) {
    const result = integrateFramingFixture(fixtureId, { enabled: true });

    assert.equal(result.requestValidation.valid, true, fixtureId);
    assert.equal(result.tracksValidation.valid, true, fixtureId);
    assert.equal(result.producerValidation.valid, true, fixtureId);
    assert.equal(result.producerSuggestion.originalFrameFallback, false, fixtureId);
    assert.equal(result.consumer.ok, false, fixtureId);
    assert.equal(result.consumer.error.code, 'missing-proof', fixtureId);
    assert.equal(result.consumer.suggestion.mode, 'original', fixtureId);
  }
});

test('actual producer fallback remains an honest consumer fallback', () => {
  const result = integrateFramingFixture('missing-detections', { enabled: true });

  assert.equal(result.producerValidation.valid, true);
  assert.equal(result.producerSuggestion.originalFrameFallback, true);
  assert.equal(result.producerSuggestion.reason, 'missing-detection');
  assert.equal(result.consumer.ok, false);
  assert.equal(result.consumer.error.code, 'provider-fallback');
  assert.equal(result.consumer.suggestion.mode, 'original');
  assert.equal(result.consumer.suggestion.analysisRevision, result.request.analysisRevision);
});

test('fixture integration stays disabled unless the producer receives explicit opt-in', () => {
  const result = integrateFramingFixture('portrait-talking-head');

  assert.equal(result.producerSuggestion.originalFrameFallback, true);
  assert.equal(result.producerSuggestion.reason, 'feature-disabled');
  assert.equal(result.consumer.ok, false);
  assert.equal(result.consumer.error.code, 'provider-fallback');
});

test('producer bridge preserves the actual request and track identities', () => {
  const fixture = FRAMING_FIXTURES.find(row => row.id === 'product-demo-with-hands');
  assert.ok(fixture);

  const result = integrateProducerFraming(fixture.request, fixture.tracks, { enabled: true });

  assert.deepEqual(result.request, fixture.request);
  assert.deepEqual(result.tracks, fixture.tracks);
  assert.deepEqual(
    result.producerSuggestion.supportingTrackIds,
    ['hand-left', 'hand-right', 'product-phone'],
  );
  assert.deepEqual(result.producerSuggestion.selectedInterval, fixture.request.selectedInterval);
});

test('the exported gap report names every consumer field missing from the merged producer result', () => {
  assert.deepEqual(INTEGRATED_FRAMING_FIELD_GAPS.map(gap => gap.field), [
    'coverage',
    'movement',
    'protectedRegions',
    'unionProof',
    'captionSafeArea',
  ]);
  for (const gap of INTEGRATED_FRAMING_FIELD_GAPS) {
    assert.equal(gap.owner, 'producer');
    assert.ok(gap.requiredFor.length > 0);
  }
});
