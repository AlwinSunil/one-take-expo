import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COACH_THRESHOLDS,
  chooseCoachView,
  createCoachTakeState,
  dismissCoachCue,
  getCoachTakeDismissals,
} from '../src/features/coach/policy.ts';

const nowMs = 10_000;

function measurement(target, confidence, calibrated = true) {
  return {
    source: 'on-device-vision',
    detectorId: 'face-crop-v1',
    detectorVersion: '0.1.0',
    target,
    calibrated,
    ...(target === 'selected-face' ? { confidence } : {}),
  };
}

function observation(state, target, stableForMs = COACH_THRESHOLDS.clearStableMs, options = {}) {
  return {
    state,
    stableForMs,
    measurement: measurement(target, options.confidence, options.calibrated),
  };
}

function readyEvidence(overrides = {}) {
  return {
    status: 'ready',
    frameCapturedAtMs: 9_900,
    observations: {
      'face-clipping': observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs, { confidence: 0.99 }),
      backlight: observation('clear', 'selected-face'),
      'background-distraction': observation('clear', 'selected-face'),
      ...overrides,
    },
  };
}

function input(overrides = {}) {
  return {
    enabled: true,
    intent: 'talking-head',
    recording: false,
    speechState: 'silent',
    betweenLines: false,
    nowMs,
    lastPromptAtMs: null,
    activeCue: null,
    dismissed: [],
    evidence: readyEvidence(),
    ...overrides,
  };
}

test('chooses the highest-priority measured cue with actionable copy', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
    }),
  }));

  assert.deepEqual(result, {
    kind: 'prompt',
    cue: 'face-clipping',
    title: 'Framing',
    message: 'Give your face a little more room.',
    reason: 'Your selected face is touching the visible edge.',
  });
});

test('requires the proposed stable issue and fresh-frame windows', () => {
  const transient = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs - 1, { confidence: 0.99 }),
    }),
  }));
  const stale = chooseCoachView(input({
    nowMs: 10_000 + COACH_THRESHOLDS.staleFrameMs + 1,
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
    }),
  }));

  assert.equal(transient.kind, 'analysis-unavailable');
  assert.equal(transient.stage, 'unstable-evidence');
  assert.equal(stale.kind, 'analysis-unavailable');
  assert.equal(stale.stage, 'stale-frame');
});

test('shows all-good only after every requested cue is explicitly clear and stable', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs, { confidence: 0.99 }),
      backlight: observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs),
      'background-distraction': observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs),
    }),
  }));
  const tooSoon = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs - 1, { confidence: 0.99 }),
    }),
  }));

  assert.deepEqual(result, { kind: 'all-good', message: 'Your shot looks ready.' });
  assert.equal(tooSoon.kind, 'analysis-unavailable');
  assert.equal(tooSoon.stage, 'unstable-evidence');
});

test('keeps unsupported lighting and background analysis honest', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      backlight: { state: 'unsupported', reason: 'camera-calibration-pending' },
      'background-distraction': { state: 'unsupported', reason: 'selected-subject-model-pending' },
    }),
  }));

  assert.equal(result.kind, 'analysis-unavailable');
  assert.equal(result.stage, 'insufficient-evidence');
  assert.match(result.message, /unavailable|paused/i);
});

test('shows a measured cue when a later requested cue is unavailable', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
      backlight: { state: 'unsupported', reason: 'camera-calibration-pending' },
      'background-distraction': { state: 'unsupported', reason: 'selected-subject-model-pending' },
    }),
  }));

  assert.equal(result.kind, 'prompt');
  assert.equal(result.cue, 'face-clipping');
});

test('never accepts an uncalibrated issue as a real automatic cue', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      backlight: observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { calibrated: false }),
    }),
  }));

  assert.equal(result.kind, 'analysis-unavailable');
  assert.equal(result.stage, 'invalid-evidence');
});

test('requires face detector confidence at the researched floor', () => {
  const result = chooseCoachView(input({
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.89 }),
    }),
  }));

  assert.equal(result.kind, 'analysis-unavailable');
  assert.equal(result.stage, 'invalid-evidence');
});

test('waits for a real between-lines signal and quiet speech while recording', () => {
  const evidence = readyEvidence({
    'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
  });
  const speaking = chooseCoachView(input({ recording: true, speechState: 'speaking', betweenLines: true, evidence }));
  const unknownSpeech = chooseCoachView(input({ recording: true, speechState: 'unknown', betweenLines: true, evidence }));
  const talking = chooseCoachView(input({ recording: true, speechState: 'silent', betweenLines: false, evidence }));
  const betweenLines = chooseCoachView(input({ recording: true, speechState: 'silent', betweenLines: true, evidence }));

  assert.deepEqual(speaking, { kind: 'hidden', reason: 'quiet-during-speech' });
  assert.deepEqual(unknownSpeech, { kind: 'hidden', reason: 'quiet-during-speech' });
  assert.deepEqual(talking, { kind: 'hidden', reason: 'waiting-between-lines' });
  assert.equal(betweenLines.kind, 'prompt');
});

test('requires a creator intent and suppresses face advice for product intent', () => {
  const noIntent = chooseCoachView(input({ intent: null }));
  const product = chooseCoachView(input({
    intent: 'product',
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 9_900,
      observations: {
        'subject-clipping': observation('clear', 'selected-product'),
        backlight: observation('clear', 'selected-product'),
        'background-distraction': observation('clear', 'selected-product'),
        'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
      },
    },
  }));

  assert.deepEqual(noIntent, { kind: 'hidden', reason: 'missing-intent' });
  assert.deepEqual(product, { kind: 'all-good', message: 'Your shot looks ready.' });
});

test('uses an explicitly selected subject for subject intent', () => {
  const result = chooseCoachView(input({
    intent: 'subject',
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 9_900,
      observations: {
        'subject-clipping': observation('issue', 'selected-subject', COACH_THRESHOLDS.issueStableMs),
        backlight: observation('clear', 'selected-subject'),
        'background-distraction': observation('clear', 'selected-subject'),
      },
    },
  }));

  assert.deepEqual(result, {
    kind: 'prompt',
    cue: 'subject-clipping',
    title: 'Framing',
    message: 'Bring your subject fully into view.',
    reason: 'Your selected subject is clipped by the visible frame.',
  });
});

test('intentional look disables automatic advice without making a quality claim', () => {
  const result = chooseCoachView(input({ intent: 'intentional-look', evidence: {
    status: 'unavailable',
    reason: 'model-error',
  } }));

  assert.deepEqual(result, {
    kind: 'intentional',
    message: 'Intentional look selected. Automatic suggestions are off.',
  });
});

test('mutes a dismissed cue for the take and promotes the next measured cue', () => {
  const result = chooseCoachView(input({
    dismissed: ['face-clipping'],
    evidence: readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
      backlight: observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs),
    }),
  }));

  assert.deepEqual(result, {
    kind: 'prompt',
    cue: 'backlight',
    title: 'Lighting',
    message: 'Try facing the light.',
    reason: 'Your selected subject needs visible detail against the surrounding light.',
  });
});

test('enforces the cooldown between distinct prompts', () => {
  const cooldownNowMs = 20_000;
  const result = chooseCoachView(input({
    nowMs: cooldownNowMs,
    lastPromptAtMs: cooldownNowMs - COACH_THRESHOLDS.promptCooldownMs + 1,
    evidence: {
      ...readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
      }),
      frameCapturedAtMs: cooldownNowMs - 100,
    },
  }));
  const readyAgain = chooseCoachView(input({
    nowMs: cooldownNowMs,
    lastPromptAtMs: cooldownNowMs - COACH_THRESHOLDS.promptCooldownMs,
    evidence: {
      ...readyEvidence({
      'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
      }),
      frameCapturedAtMs: cooldownNowMs - 100,
    },
  }));

  assert.deepEqual(result, { kind: 'hidden', reason: 'prompt-cooldown' });
  assert.equal(readyAgain.kind, 'prompt');
});

test('keeps the shown cue stable while cooling down and gates a different cue', () => {
  const firstEvidence = readyEvidence({
    'face-clipping': observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs, { confidence: 0.99 }),
  });
  const first = chooseCoachView(input({ evidence: firstEvidence }));
  assert.equal(first.kind, 'prompt');

  const shown = chooseCoachView(input({
    evidence: firstEvidence,
    lastPromptAtMs: nowMs,
    activeCue: 'face-clipping',
  }));

  const nextCueEvidence = readyEvidence({
    'face-clipping': observation('clear', 'selected-face', COACH_THRESHOLDS.clearStableMs, { confidence: 0.99 }),
    backlight: observation('issue', 'selected-face', COACH_THRESHOLDS.issueStableMs),
  });
  const differentDuringCooldown = chooseCoachView(input({
    evidence: nextCueEvidence,
    lastPromptAtMs: nowMs,
    activeCue: 'face-clipping',
  }));
  const differentAfterCooldown = chooseCoachView(input({
    nowMs: nowMs + COACH_THRESHOLDS.promptCooldownMs,
    evidence: {
      ...nextCueEvidence,
      frameCapturedAtMs: nowMs + COACH_THRESHOLDS.promptCooldownMs - 100,
    },
    lastPromptAtMs: nowMs,
    activeCue: 'face-clipping',
  }));

  assert.deepEqual(shown, first);
  assert.deepEqual(differentDuringCooldown, { kind: 'hidden', reason: 'prompt-cooldown' });
  assert.equal(differentAfterCooldown.kind, 'prompt');
  assert.equal(differentAfterCooldown.cue, 'backlight');
});

test('resets take-local dismissals synchronously when the take key changes', () => {
  const takeOne = dismissCoachCue(createCoachTakeState('take-1'), 'take-1', 'face-clipping');

  assert.deepEqual(getCoachTakeDismissals(takeOne, 'take-1'), ['face-clipping']);
  assert.deepEqual(getCoachTakeDismissals(takeOne, 'take-2'), []);

  const takeTwo = dismissCoachCue(takeOne, 'take-2', 'backlight');
  assert.deepEqual(takeTwo, { takeId: 'take-2', dismissed: ['backlight'] });
});

test('represents pending and unavailable vision without blocking the shot', () => {
  const pending = chooseCoachView(input({ evidence: { status: 'pending', reason: 'model-loading' } }));
  const unavailable = chooseCoachView(input({ evidence: { status: 'unavailable', reason: 'unsupported-device' } }));
  const disabled = chooseCoachView(input({ enabled: false, evidence: { status: 'unavailable', reason: 'model-error' } }));

  assert.equal(pending.kind, 'analysis-unavailable');
  assert.equal(pending.stage, 'pending');
  assert.equal(unavailable.kind, 'analysis-unavailable');
  assert.equal(unavailable.stage, 'unavailable');
  assert.deepEqual(disabled, { kind: 'hidden', reason: 'disabled' });
});
