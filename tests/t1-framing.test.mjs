import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ORIGINAL_FRAMING_CROP,
  buildFramingPlan,
  toNativeCrop,
  validateFramingSuggestion,
} from '../src/lib/t1-framing.ts';

const fixture = JSON.parse(await readFile(new URL('../tools/fixtures/t1-framing.json', import.meta.url), 'utf8'));

test('deterministic framing fixtures accept only safe static crops', () => {
  for (const row of fixture.cases) {
    const { expected, ...input } = row.input;
    const result = buildFramingPlan(input);
    const decision = result.cuts[0];

    assert.equal(decision.mode, expected.mode, row.id);
    if (expected.suggestionId) assert.equal(decision.suggestionId, expected.suggestionId, row.id);
    if (expected.fallbackReason) assert.equal(decision.fallbackReason, expected.fallbackReason, row.id);
    if (expected.crop) assert.deepEqual(decision.crop, expected.crop, row.id);
    if (expected.nativeCrop) assert.deepEqual(decision.nativeCrop, expected.nativeCrop, row.id);
    assert.deepEqual(decision.startSec, input.cuts[0].startSec, row.id);
    assert.deepEqual(decision.endSec, input.cuts[0].endSec, row.id);
  }
});

test('the default plan is original footage and explicit opt-in is required', () => {
  const input = fixture.cases.find(row => row.id === 'portrait-ready').input;
  const result = buildFramingPlan({ ...input, enabled: undefined });
  assert.equal(result.enabled, false);
  assert.equal(result.cuts[0].mode, 'original');
  assert.equal(result.cuts[0].fallbackReason, 'disabled');
  assert.deepEqual(result.cuts[0].crop, ORIGINAL_FRAMING_CROP);
});

test('one cut receives one frozen crop decision shared by preview and export', () => {
  const input = fixture.cases.find(row => row.id === 'portrait-ready').input;
  const result = buildFramingPlan(input);
  const decision = result.cuts[0];

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.cuts), true);
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.crop), true);
  assert.deepEqual(decision.nativeCrop, toNativeCrop(decision.crop));
  assert.equal(decision.startSec, 2);
  assert.equal(decision.endSec, 5);
});

test('native crop projection maps top-left upright coordinates to Media3 coordinates', () => {
  assert.deepEqual(toNativeCrop({ x: 0, y: 0, width: 1, height: 1 }), {
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  });
  assert.deepEqual(toNativeCrop({ x: 0.1, y: 0.2, width: 0.8, height: 0.6 }), {
    left: -0.8,
    right: 0.8,
    bottom: -0.6,
    top: 0.6,
  });
});

test('suggestion validation rejects malformed geometry and non-fixture provenance', () => {
  const input = fixture.cases.find(row => row.id === 'portrait-ready').input.suggestions[0];
  const malformed = validateFramingSuggestion({
    ...input,
    crop: { x: 0.3, y: 0.2, width: 0.8, height: 0.8 },
  });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.some(error => /crop.*bounds|aspect|zoom/i.test(error)));

  const unknownProvider = validateFramingSuggestion({
    ...input,
    provenance: { ...input.provenance, provider: 'cloud' },
  });
  assert.equal(unknownProvider.valid, false);
  assert.ok(unknownProvider.errors.some(error => /provenance|provider/i.test(error)));
});

test('a malformed provider row can never become a playable reframed decision', () => {
  const input = fixture.cases.find(row => row.id === 'portrait-ready').input;
  const result = buildFramingPlan({
    ...input,
    suggestions: [{ ...input.suggestions[0], crop: { x: 0.3, y: 0.2, width: 0.8, height: 0.8 } }],
  });
  assert.equal(result.cuts[0].mode, 'original');
  assert.equal(result.cuts[0].fallbackReason, 'invalid-suggestion');
  assert.equal(result.cuts[0].suggestionId, undefined);
});

test('missing source media and overlapping suggestions preserve the original frame', () => {
  const input = fixture.cases.find(row => row.id === 'portrait-ready').input;
  const missingMedia = buildFramingPlan({
    ...input,
    cuts: [{ ...input.cuts[0], mediaAvailable: false }],
  });
  assert.equal(missingMedia.cuts[0].mode, 'original');
  assert.equal(missingMedia.cuts[0].fallbackReason, 'missing-media');

  const overlapping = buildFramingPlan({
    ...input,
    suggestions: [input.suggestions[0], { ...input.suggestions[0], analysisId: 'analysis-portrait-2' }],
  });
  assert.equal(overlapping.cuts[0].mode, 'original');
  assert.equal(overlapping.cuts[0].fallbackReason, 'ambiguous-suggestion');
});

test('unavailable producer evidence can omit crop geometry and still falls back honestly', () => {
  const result = buildFramingPlan({
    sourceMediaId: 'recording-unavailable',
    enabled: true,
    cuts: [{ sourceMediaId: 'recording-unavailable', takeId: 'take-1', startSec: 0, endSec: 2 }],
    suggestions: [{
      version: 1,
      sourceMediaId: 'recording-unavailable',
      takeId: 'take-1',
      analysisId: 'analysis-unavailable-1',
      sourceDurationSec: 4,
      interval: { startSec: 0, endSec: 2 },
      intent: 'vlog',
      frame: { uprightWidthPx: 1920, uprightHeightPx: 1080, rotationDegrees: 0 },
      coverage: 'unknown',
      movement: 'unknown',
      status: 'unavailable',
      provenance: { provider: 'fixture', model: 'fixture-framing-v1', processor: 'cpu' },
      reason: 'No vision track was supplied.',
    }],
  });
  assert.equal(result.cuts[0].mode, 'original');
  assert.equal(result.cuts[0].fallbackReason, 'uncertain-evidence');
});
