import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER1_COACHING_DEFAULT_ENABLED,
  TIER1_SPEECH_STALE_MS,
  createTier1TipState,
  dismissTier1SetupTip,
  getNextTier1SetupTip,
  getTier1ManualSetupTips,
  gateTier1Coach,
  revisitTier1SetupTips,
  toCompositionCoachIntent,
} from '../src/features/coach/tier1-policy.ts';
import {
  replayTier1DevelopmentFixture,
  TIER1_DEVELOPMENT_FIXTURES,
} from '../src/features/coach/tier1-fixtures.ts';

const baseInput = {
  enabled: true,
  intent: 'talking-head',
  recording: false,
  nowMs: 10_000,
  takeId: 'take-1',
  captureGeneration: 'front-generation-1',
  priority: {
    takeId: 'take-1',
    observedAtMs: 9_900,
    captureGeneration: 'front-generation-1',
    coverageOrActionRequired: false,
  },
  speech: {
    takeId: 'take-1',
    captureGeneration: 'front-generation-1',
    observedAtMs: 9_900,
    state: 'silent',
    betweenLines: false,
  },
};

test('Tier 1 coaching is disabled by default', () => {
  assert.equal(TIER1_COACHING_DEFAULT_ENABLED, false);
  assert.deepEqual(gateTier1Coach({ ...baseInput, enabled: TIER1_COACHING_DEFAULT_ENABLED }), {
    kind: 'hidden',
    reason: 'disabled',
  });
});

test('maps Tier 1 shot intent to the existing Tier 0 coach vocabulary', () => {
  assert.equal(toCompositionCoachIntent('talking-head'), 'talking-head');
  assert.equal(toCompositionCoachIntent('vlog'), 'subject');
  assert.equal(toCompositionCoachIntent('product-demo'), 'product');
  assert.equal(toCompositionCoachIntent('intentional-look'), 'intentional-look');
  assert.equal(toCompositionCoachIntent(null), null);
});

test('requires explicit intent and keeps intentional looks quiet', () => {
  assert.deepEqual(gateTier1Coach({ ...baseInput, intent: null }), {
    kind: 'hidden',
    reason: 'missing-intent',
  });
  assert.deepEqual(gateTier1Coach({ ...baseInput, intent: 'intentional-look' }), {
    kind: 'intentional',
  });
});

test('required work and speech silence intentional-look status during a take', () => {
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    intent: 'intentional-look',
    recording: true,
    speech: { ...baseInput.speech, state: 'speaking', betweenLines: true },
  }), { kind: 'hidden', reason: 'speech-active' });
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    intent: 'intentional-look',
    priority: { ...baseInput.priority, coverageOrActionRequired: true },
  }), { kind: 'hidden', reason: 'coverage-or-action-required' });
});

test('coverage and required actions outrank optional coaching', () => {
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    priority: { ...baseInput.priority, coverageOrActionRequired: true },
  }), {
    kind: 'hidden',
    reason: 'coverage-or-action-required',
  });
});

test('does not treat missing or stale priority as permission to coach while recording', () => {
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, betweenLines: true },
    priority: null,
  }), { kind: 'hidden', reason: 'priority-unknown' });

  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, betweenLines: true },
    priority: {
      ...baseInput.priority,
      takeId: 'old-take',
      coverageOrActionRequired: false,
    },
  }), { kind: 'hidden', reason: 'priority-stale' });

  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, betweenLines: true },
    priority: {
      ...baseInput.priority,
      observedAtMs: baseInput.nowMs - TIER1_SPEECH_STALE_MS - 1,
      coverageOrActionRequired: false,
    },
  }), { kind: 'hidden', reason: 'priority-stale' });
});

test('keeps optional coaching quiet while recording speech or waiting for a line break', () => {
  const recording = { ...baseInput, recording: true };

  assert.deepEqual(gateTier1Coach({
    ...recording,
    speech: { ...recording.speech, state: 'speaking', betweenLines: true },
  }), { kind: 'hidden', reason: 'speech-active' });
  assert.deepEqual(gateTier1Coach({
    ...recording,
    speech: { ...recording.speech, state: 'unknown', betweenLines: true },
  }), { kind: 'hidden', reason: 'speech-unknown' });
  assert.deepEqual(gateTier1Coach({
    ...recording,
    speech: { ...recording.speech, state: 'silent', betweenLines: false },
  }), { kind: 'hidden', reason: 'waiting-between-lines' });
  assert.equal(gateTier1Coach({
    ...recording,
    speech: { ...recording.speech, state: 'silent', betweenLines: true },
  }).kind, 'delegate');
});

test('suppresses stale or cross-take transcript signals', () => {
  const staleAt = baseInput.nowMs - TIER1_SPEECH_STALE_MS - 1;
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, observedAtMs: staleAt },
  }), { kind: 'hidden', reason: 'speech-stale' });
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, takeId: 'old-take' },
  }), { kind: 'hidden', reason: 'speech-stale' });
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, captureGeneration: 'back-generation-2' },
  }), { kind: 'hidden', reason: 'speech-stale' });
});

test('delegates only the mapped intent and preserves the transcript seam', () => {
  const result = gateTier1Coach({
    ...baseInput,
    intent: 'product-demo',
    recording: true,
    speech: { ...baseInput.speech, state: 'silent', betweenLines: true },
  });

  assert.deepEqual(result, {
    kind: 'delegate',
    intent: 'product',
    recording: true,
    speechState: 'silent',
    betweenLines: true,
  });
});

test('manual setup tips cover framing, background and lighting without automatic evidence', () => {
  const intents = ['talking-head', 'vlog', 'product-demo'];
  for (const intent of intents) {
    const tips = getTier1ManualSetupTips(intent);
    assert.ok(tips.length >= 3, `${intent} should have multiple manual tips`);
    assert.ok(tips.some(tip => tip.cue === 'subject-framing'));
    assert.ok(tips.some(tip => tip.cue === 'background-separation'));
    assert.ok(tips.some(tip => tip.cue === 'background-distraction'));
    assert.ok(tips.some(tip => tip.cue === 'lighting'));
    for (const tip of tips) {
      assert.equal(tip.provenance, 'manual-creator-guidance');
      assert.ok(tip.reason.length > 0);
      assert.ok(tip.action.length > 0);
    }
  }

  const productCopy = getTier1ManualSetupTips('product-demo')
    .map(tip => `${tip.title} ${tip.message} ${tip.reason} ${tip.action}`)
    .join(' ');
  assert.doesNotMatch(productCopy, /put your face|face in frame|show your face/i);
  assert.deepEqual(getTier1ManualSetupTips('intentional-look'), []);
});

test('development fixtures route by intent while remaining manual-only', () => {
  for (const fixture of TIER1_DEVELOPMENT_FIXTURES) {
    assert.equal(fixture.label, 'synthetic-development-only');
    const delegated = replayTier1DevelopmentFixture(fixture);
    const tips = getTier1ManualSetupTips(fixture.intent);
    const firstTip = getNextTier1SetupTip(createTier1TipState(fixture.intent));
    assert.ok(fixture.scene);
    assert.ok(tips.every(tip => tip.provenance === 'manual-creator-guidance'));
    assert.equal(firstTip?.cue ?? null, fixture.intent === 'intentional-look' ? null : 'subject-framing');
    assert.equal(delegated.kind, fixture.expected, fixture.id);
    if (fixture.expected === 'hidden') {
      assert.equal(fixture.input.recording, true);
      assert.notEqual(delegated.kind, 'prompt');
    }
  }
});

test('manual tips are shown one at a time and dismissal is scoped to intent', () => {
  const talkingHeadState = createTier1TipState('talking-head');
  const first = getNextTier1SetupTip(talkingHeadState);
  assert.equal(first?.cue, 'subject-framing');

  const dismissed = dismissTier1SetupTip(
    talkingHeadState,
    'talking-head',
    first.cue,
  );
  assert.equal(getNextTier1SetupTip(dismissed)?.cue, 'background-separation');
  assert.equal(getNextTier1SetupTip(createTier1TipState('vlog'))?.cue, 'subject-framing');

  const revisited = revisitTier1SetupTips(dismissed, 'talking-head');
  assert.deepEqual(revisited, { intent: 'talking-head', dismissed: [] });
  assert.equal(getNextTier1SetupTip(revisited)?.cue, 'subject-framing');
});

test('invalid clocks and missing speech evidence fail closed while setup remains available', () => {
  assert.deepEqual(gateTier1Coach({ ...baseInput, nowMs: Number.NaN }), {
    kind: 'hidden',
    reason: 'invalid-clock',
  });
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, betweenLines: true },
    priority: undefined,
  }), { kind: 'hidden', reason: 'priority-unknown' });
  assert.deepEqual(gateTier1Coach({
    ...baseInput,
    recording: true,
    speech: { ...baseInput.speech, betweenLines: true },
    priority: { ...baseInput.priority, coverageOrActionRequired: 'unknown' },
  }), { kind: 'hidden', reason: 'priority-unknown' });
  assert.deepEqual(gateTier1Coach({ ...baseInput, recording: true, speech: null }), {
    kind: 'hidden',
    reason: 'speech-unknown',
  });
  assert.equal(gateTier1Coach({ ...baseInput, speech: null }).kind, 'delegate');
});
