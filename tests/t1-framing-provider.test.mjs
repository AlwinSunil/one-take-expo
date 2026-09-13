import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptProviderFramingSuggestion,
  PROVIDER_FRAMING_OWNER_ADDITIONS,
} from '../src/lib/t1-framing-provider.ts';
import { buildFramingPlan } from '../src/lib/t1-framing.ts';

function request(overrides = {}) {
  return {
    sourceMediaId: 'recording-portrait',
    takeId: 'take-1',
    analysisId: 'analysis-portrait-1',
    analysisRevision: 4,
    sourceDurationMs: 12000,
    selectedInterval: { startMs: 2000, endMs: 5000 },
    intent: 'talking-head',
    frame: {
      coordinateSpace: 'normalized-upright-unmirrored',
      orientation: 'portrait',
      rotationDegrees: 0,
      uprightWidthPx: 1080,
      uprightHeightPx: 1920,
      aspectRatio: 1080 / 1920,
    },
    provenance: {
      source: 'fixture',
      model: 'fixture-framing',
      modelVersion: 'v1',
      processor: 'cpu',
      runtime: 'host-fixture',
      fixtureId: 'portrait-ready',
    },
    ...overrides,
  };
}

function publishedSuggestion(overrides = {}) {
  return {
    contractVersion: 1,
    sourceMediaId: 'recording-portrait',
    takeId: 'take-1',
    analysisId: 'analysis-portrait-1',
    analysisRevision: 4,
    sourceDurationMs: 12000,
    selectedInterval: { startMs: 2000, endMs: 5000 },
    intent: 'talking-head',
    frame: request().frame,
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    confidence: 0.9,
    reason: 'talking-head-subject',
    reasons: ['talking-head-subject', 'stable-union-crop'],
    reasonText: 'Keep the selected subject in view.',
    supportingTrackIds: ['face-1'],
    originalFrameFallback: false,
    provenance: request().provenance,
    ...overrides,
  };
}

function enrichedSuggestion(overrides = {}) {
  return publishedSuggestion({
    coverage: 'complete',
    movement: 'stable',
    protectedRegions: [{
      trackId: 'face-1',
      kind: 'face',
      rect: { x: 0.35, y: 0.2, width: 0.2, height: 0.2 },
      confidence: 0.92,
      relevant: true,
    }],
    unionProof: {
      kind: 'stable-union',
      interval: { startMs: 2000, endMs: 5000 },
      trackIds: ['face-1'],
      startBoundaryCovered: true,
      endBoundaryCovered: true,
    },
    captionSafeArea: { x: 0.2, y: 0.72, width: 0.6, height: 0.12 },
    ...overrides,
  });
}

test('published producer shape fails closed until union, region, movement, coverage, and caption proof are published', () => {
  const result = adaptProviderFramingSuggestion(publishedSuggestion(), request());

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing-proof');
  assert.equal(result.suggestion.mode, 'original');
  assert.equal(result.suggestion.analysisRevision, 4);
  assert.equal(result.suggestion.startSec, 2);
  assert.equal(result.suggestion.endSec, 5);
  for (const addition of PROVIDER_FRAMING_OWNER_ADDITIONS) {
    assert.equal(result.error.requestedOwnerAdditions.includes(addition), true, addition);
  }
});

test('an enriched stable union converts milliseconds exactly and is consumable by the framing plan', () => {
  const result = adaptProviderFramingSuggestion(enrichedSuggestion(), request());

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.suggestion.analysisRevision, 4);
  assert.deepEqual(result.suggestion.interval, { startSec: 2, endSec: 5 });
  assert.equal(result.suggestion.sourceDurationSec, 12);
  assert.deepEqual(result.suggestion.frame, {
    uprightWidthPx: 1080,
    uprightHeightPx: 1920,
    rotationDegrees: 0,
  });
  assert.deepEqual(result.suggestion.protectedKinds, ['face']);
  assert.deepEqual(result.suggestion.regions, [{
    trackId: 'face-1',
    kind: 'face',
    rect: { x: 0.35, y: 0.2, width: 0.2, height: 0.2 },
    confidence: 0.92,
    relevant: true,
  }]);
  assert.deepEqual(result.suggestion.captionSafeArea, { x: 0.2, y: 0.72, width: 0.6, height: 0.12 });

  const plan = buildFramingPlan({
    sourceMediaId: 'recording-portrait',
    enabled: true,
    cuts: [{ sourceMediaId: 'recording-portrait', takeId: 'take-1', startSec: 2, endSec: 5 }],
    suggestions: [result.suggestion],
  });
  assert.equal(plan.cuts[0].mode, 'reframed');
  assert.deepEqual(plan.cuts[0].crop, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
});

test('stale source, take, analysis, revision, interval, or frame identity rejects the provider crop', () => {
  const current = request();
  for (const overrides of [
    { sourceMediaId: 'recording-old' },
    { takeId: 'take-old' },
    { analysisId: 'analysis-old' },
    { analysisRevision: 5 },
    { selectedInterval: { startMs: 3000, endMs: 5000 } },
    { frame: { ...current.frame, rotationDegrees: 90 } },
  ]) {
    const result = adaptProviderFramingSuggestion(enrichedSuggestion(), { ...current, ...overrides });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.error.code, 'identity-mismatch', JSON.stringify(overrides));
    assert.equal(result.suggestion.mode, 'original', JSON.stringify(overrides));
    assert.equal(result.suggestion.analysisRevision, current.analysisRevision, JSON.stringify(overrides));
  }
});

test('boundary proof and caption safe area are mandatory even when the crop is geometrically valid', () => {
  const missingBoundary = adaptProviderFramingSuggestion(enrichedSuggestion({
    unionProof: {
      ...enrichedSuggestion().unionProof,
      endBoundaryCovered: false,
    },
  }), request());
  assert.equal(missingBoundary.ok, false);
  assert.equal(missingBoundary.error.code, 'missing-proof');
  assert.equal(missingBoundary.suggestion.mode, 'original');

  const missingCaptionArea = adaptProviderFramingSuggestion(enrichedSuggestion({ captionSafeArea: undefined }), request());
  assert.equal(missingCaptionArea.ok, false);
  assert.equal(missingCaptionArea.error.code, 'missing-caption-safe-area');
  assert.equal(missingCaptionArea.suggestion.mode, 'original');
});

test('producer original fallback remains original without pretending it is a usable crop', () => {
  const result = adaptProviderFramingSuggestion(publishedSuggestion({
    originalFrameFallback: true,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    confidence: 0,
    reason: 'missing-detection',
    reasons: ['missing-detection'],
  }), request());

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'provider-fallback');
  assert.equal(result.suggestion.mode, 'original');
  assert.equal(result.suggestion.fallbackReason, 'missing-suggestion');
  assert.deepEqual(result.suggestion.crop, { x: 0, y: 0, width: 1, height: 1 });
});
