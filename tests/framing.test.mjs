import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFramingSuggestion,
  FRAMING_DEFAULTS,
  isFramingSuggestionCurrent,
  ORIGINAL_FRAME_RECT,
  validateFramingRequest,
  validateFramingSuggestion,
} from '../src/features/vision/framing.ts';
import {
  FRAMING_FIXTURES,
  FRAMING_FIXTURE_POLICY,
  replayDevelopmentFramingFixtures,
  replayFramingFixtures,
} from '../src/features/vision/framing-fixtures.ts';

const enabled = { enabled: true };

function fixture(id) {
  const value = FRAMING_FIXTURES.find(candidate => candidate.id === id);
  assert.ok(value, `missing fixture ${id}`);
  return value;
}

function contains(crop, rect) {
  return crop.x <= rect.x
    && crop.y <= rect.y
    && crop.x + crop.width >= rect.x + rect.width
    && crop.y + crop.height >= rect.y + rect.height;
}

test('development fixture replay is deterministic and every expected state validates', () => {
  const first = replayDevelopmentFramingFixtures();
  const second = replayDevelopmentFramingFixtures();
  assert.deepEqual(first, second);
  assert.equal(first.every(row => row.passed && row.validation.valid), true);
  assert.equal(first.length >= 10, true);
  assert.deepEqual(FRAMING_FIXTURE_POLICY, {
    source: 'fixture',
    developmental: true,
    enabledByDefault: false,
    execution: 'host-cpu',
    actualProcessor: 'cpu',
    inferenceHardware: 'none',
  });
});

test('framing defaults remain disabled and return an explicit original-frame fallback', () => {
  const moving = fixture('moving-vlog-subject');
  const suggestion = buildFramingSuggestion(moving.request, moving.tracks);
  assert.equal(FRAMING_DEFAULTS.enabled, false);
  assert.equal(suggestion.originalFrameFallback, true);
  assert.equal(suggestion.reason, 'feature-disabled');
  assert.deepEqual(suggestion.crop, ORIGINAL_FRAME_RECT);
  assert.equal(validateFramingSuggestion(suggestion, moving.request).valid, true);

  const explicit = replayFramingFixtures();
  assert.equal(explicit.every(row => row.actual.reason === 'feature-disabled'), true);
});

test('talking-head and moving-vlog crops use one temporal union with bounded zoom', () => {
  for (const id of ['portrait-talking-head', 'moving-vlog-subject']) {
    const sample = fixture(id);
    const suggestion = buildFramingSuggestion(sample.request, sample.tracks, enabled);
    assert.equal(suggestion.originalFrameFallback, false);
    assert.equal(suggestion.reason, sample.expected.reason);
    assert.equal(suggestion.crop.width, suggestion.crop.height);
    assert.ok(suggestion.crop.width >= 1 / 1.35);
    assert.ok(suggestion.crop.width < 1);
    for (const track of sample.tracks) {
      for (const observation of track.observations) {
        if (observation.timestampMs >= sample.request.selectedInterval.startMs
          && observation.timestampMs < sample.request.selectedInterval.endMs) {
          assert.equal(contains(suggestion.crop, observation.rect), true);
        }
      }
    }
    assert.equal(isFramingSuggestionCurrent(suggestion, sample.request), true);
  }
});

test('product-demo crop preserves the selected product and every relevant hand', () => {
  const sample = fixture('product-demo-with-hands');
  const suggestion = buildFramingSuggestion(sample.request, sample.tracks, enabled);
  assert.equal(suggestion.originalFrameFallback, false);
  assert.equal(suggestion.reason, 'product-and-hands');
  assert.deepEqual(suggestion.supportingTrackIds, ['hand-left', 'hand-right', 'product-phone']);
  for (const track of sample.tracks) {
    for (const observation of track.observations) assert.equal(contains(suggestion.crop, observation.rect), true);
  }
  assert.equal(validateFramingSuggestion(suggestion, sample.request).valid, true);
});

test('multiple subjects are preserved when possible and fall back when the union is unsafe', () => {
  const safe = fixture('multiple-people-safe');
  const safeSuggestion = buildFramingSuggestion(safe.request, safe.tracks, enabled);
  assert.equal(safeSuggestion.originalFrameFallback, false);
  assert.equal(safeSuggestion.reasons.includes('multiple-subjects-preserved'), true);
  assert.deepEqual(safeSuggestion.supportingTrackIds, ['face-left', 'face-right']);

  const unsafe = fixture('multiple-people-unsafe');
  const unsafeSuggestion = buildFramingSuggestion(unsafe.request, unsafe.tracks, enabled);
  assert.equal(unsafeSuggestion.originalFrameFallback, true);
  assert.equal(unsafeSuggestion.reason, 'unsafe-multiple-subjects');
  assert.deepEqual(unsafeSuggestion.crop, ORIGINAL_FRAME_RECT);
});

test('missing, off-frame, uncertain, discontinuous and product-without-hands inputs fall back safely', () => {
  const expected = new Map([
    ['missing-detections', 'missing-detection'],
    ['off-frame-detection', 'off-frame'],
    ['low-confidence', 'low-confidence'],
    ['discontinuous-track', 'discontinuous-track'],
    ['product-demo-missing-hands', 'hands-missing'],
    ['product-only-talk-intent', 'no-relevant-subject'],
  ]);
  for (const [id, reason] of expected) {
    const sample = fixture(id);
    const suggestion = buildFramingSuggestion(sample.request, sample.tracks, enabled);
    assert.equal(suggestion.originalFrameFallback, true, id);
    assert.equal(suggestion.reason, reason, id);
    assert.deepEqual(suggestion.crop, ORIGINAL_FRAME_RECT, id);
    assert.equal(validateFramingSuggestion(suggestion, sample.request).valid, true, id);
  }
});

test('the selected interval is half-open and requires coverage through its temporal boundary', () => {
  const sample = fixture('moving-vlog-subject');
  const request = { ...sample.request, selectedInterval: { startMs: 0, endMs: 500 } };
  const tracks = sample.tracks.map(track => ({
    ...track,
    observations: [track.observations[1]],
  }));
  const suggestion = buildFramingSuggestion(request, tracks, enabled);
  assert.equal(suggestion.originalFrameFallback, true);
  assert.equal(suggestion.reason, 'missing-detection');

  const boundaryObservation = {
    ...sample.tracks[0].observations[0],
    timestampMs: request.selectedInterval.endMs,
  };
  const boundaryTracks = sample.tracks.map(track => ({
    ...track,
    observations: [boundaryObservation],
  }));
  const boundarySuggestion = buildFramingSuggestion(request, boundaryTracks, enabled);
  assert.equal(boundarySuggestion.originalFrameFallback, true);
  assert.equal(boundarySuggestion.reason, 'missing-detection');
});

test('track identity and immutable request changes invalidate stale framing results', () => {
  const sample = fixture('moving-vlog-subject');
  const suggestion = buildFramingSuggestion(sample.request, sample.tracks, enabled);
  assert.equal(validateFramingSuggestion(suggestion, sample.request).valid, true);

  const staleTrack = sample.tracks.map(track => ({
    ...track,
    identity: { ...track.identity, takeId: 'old-take' },
  }));
  const staleTrackSuggestion = buildFramingSuggestion(sample.request, staleTrack, enabled);
  assert.equal(staleTrackSuggestion.originalFrameFallback, true);
  assert.equal(staleTrackSuggestion.reason, 'identity-mismatch');

  for (const change of [
    { takeId: 'new-take' },
    { sourceMediaId: 'new-media' },
    { analysisId: 'new-analysis' },
    { analysisRevision: 2 },
    { intent: 'talking-head' },
    { selectedInterval: { startMs: 500, endMs: 3000 } },
    { frame: { ...sample.request.frame, rotationDegrees: 90 } },
  ]) {
    const changedRequest = { ...sample.request, ...change };
    const validation = validateFramingSuggestion(suggestion, changedRequest);
    assert.equal(validation.valid, false, JSON.stringify(change));
    assert.ok(validation.errors.some(error => /identity|orientation|geometry|interval/.test(error)));
  }
});

test('validators enforce provenance, max zoom, crop shape and explicit fallback semantics', () => {
  const sample = fixture('portrait-talking-head');
  assert.equal(validateFramingRequest(sample.request).valid, true);
  const suggestion = buildFramingSuggestion(sample.request, sample.tracks, enabled);

  const tooTight = {
    ...suggestion,
    crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
  };
  const tightValidation = validateFramingSuggestion(tooTight, sample.request);
  assert.equal(tightValidation.valid, false);
  assert.ok(tightValidation.errors.some(error => error.includes('1.35x')));

  const missingIds = { ...suggestion, supportingTrackIds: [] };
  const idsValidation = validateFramingSuggestion(missingIds, sample.request);
  assert.equal(idsValidation.valid, false);
  assert.ok(idsValidation.errors.some(error => error.includes('supporting track ids')));

  const wrongFallbackReason = {
    ...suggestion,
    originalFrameFallback: true,
    crop: ORIGINAL_FRAME_RECT,
    confidence: 0,
    reason: 'talking-head-subject',
    reasons: ['talking-head-subject'],
    reasonText: 'Keep the selected subject in view.',
    supportingTrackIds: [],
  };
  const fallbackValidation = validateFramingSuggestion(wrongFallbackReason, sample.request);
  assert.equal(fallbackValidation.valid, false);
  assert.ok(fallbackValidation.errors.some(error => error.includes('fallback reason')));

  const invalidFixtureProvenance = { ...sample.request, provenance: { ...sample.request.provenance, processor: 'npu' } };
  assert.equal(validateFramingRequest(invalidFixtureProvenance).valid, false);

  const unsafeOptions = buildFramingSuggestion(sample.request, sample.tracks, { enabled: true, maxZoom: 2 });
  assert.equal(unsafeOptions.originalFrameFallback, true);
  assert.equal(unsafeOptions.reason, 'invalid-options');
  assert.doesNotThrow(() => buildFramingSuggestion(null, [], enabled));
  assert.equal(buildFramingSuggestion(null, [], enabled).reason, 'invalid-request');
});

test('target-aspect conversion remains an original-frame fallback until validated', () => {
  const sample = fixture('portrait-talking-head');
  const result = buildFramingSuggestion(sample.request, sample.tracks, {
    enabled: true,
    targetAspectRatio: 16 / 9,
  });
  assert.equal(result.originalFrameFallback, true);
  assert.equal(result.reason, 'target-aspect-unvalidated');
  assert.deepEqual(result.crop, ORIGINAL_FRAME_RECT);
});
