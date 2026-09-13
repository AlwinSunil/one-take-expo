import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSuggestionJobController,
  evaluateSuggestionRequest,
} from '../src/features/coach/suggestion-job.ts';

function request(overrides = {}) {
  return {
    sessionId: 'capture-session-1',
    lensGeneration: 'back-generation-1',
    intent: 'talking-head',
    requestedAtMs: 1_000,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function allGood(message = 'The measured cues look clear.') {
  return {
    kind: 'all-good',
    message,
    evidence: {
      source: 'fixture',
      calibrated: true,
      detectorId: 'fixture-detector',
      detectorVersion: 'fixture-1',
    },
  };
}

function measured(state, target = 'selected-face', stableForMs = 1_500, confidence = 0.99) {
  return {
    state,
    stableForMs,
    measurement: {
      source: 'on-device-vision',
      detectorId: 'calibrated-fixture-detector',
      detectorVersion: 'fixture-1',
      target,
      calibrated: true,
      ...(target === 'selected-face' ? { confidence } : {}),
    },
  };
}

test('five fresh sessions start zero suggestion jobs before an explicit tap', () => {
  const controllers = Array.from({ length: 5 }, (_, index) => createSuggestionJobController({
    evaluator: async () => allGood(),
  }));

  for (const [index, controller] of controllers.entries()) {
    controller.bind({
      sessionId: `session-${index + 1}`,
      lensGeneration: `front-generation-${index + 1}`,
      intent: 'talking-head',
    });
    assert.equal(controller.getSnapshot().status, 'idle');
    assert.equal(controller.getDiagnostics().starts, 0);
    assert.equal(controller.getDiagnostics().evaluations, 0);
  }
});

test('an explicit request is the only path that starts bounded evaluation', async () => {
  let evaluations = 0;
  const controller = createSuggestionJobController({
    evaluator: async () => {
      evaluations += 1;
      return allGood();
    },
  });
  const identity = {
    sessionId: 'capture-session-1',
    lensGeneration: 'back-generation-1',
    intent: 'talking-head',
  };

  controller.bind(identity);
  assert.equal(evaluations, 0);
  const loading = controller.start(request());
  assert.equal(loading.status, 'loading');
  await Promise.resolve();
  assert.equal(evaluations, 1);
  await controller.whenSettled();
  assert.equal(controller.getSnapshot().status, 'all-good');
  assert.equal(controller.getDiagnostics().starts, 1);
  assert.equal(controller.getDiagnostics().evaluations, 1);
});

test('duplicate taps while loading deduplicate to one job and one evaluation', async () => {
  const pending = deferred();
  let evaluations = 0;
  const controller = createSuggestionJobController({
    evaluator: async () => {
      evaluations += 1;
      return pending.promise;
    },
  });

  const first = controller.start(request());
  const second = controller.start(request({ requestedAtMs: 1_001 }));

  assert.equal(first.status, 'loading');
  assert.equal(second.status, 'loading');
  assert.equal(second.jobId, first.jobId);
  await Promise.resolve();
  assert.equal(evaluations, 1);
  assert.equal(controller.getDiagnostics().starts, 1);

  pending.resolve(allGood());
  await controller.whenSettled();
  assert.equal(controller.getSnapshot().status, 'all-good');
});

test('cancel or invalidate before the evaluator microtask performs no bounded work', async () => {
  for (const mode of ['cancel', 'invalidate']) {
    let evaluatorCalls = 0;
    const controller = createSuggestionJobController({
      evaluator: async () => {
        evaluatorCalls += 1;
        return allGood();
      },
    });

    controller.bind({
      sessionId: 'capture-session-1',
      lensGeneration: 'back-generation-1',
      intent: 'talking-head',
    });
    controller.start(request());
    const terminal = mode === 'cancel'
      ? controller.cancel('manual')
      : controller.invalidate({
        sessionId: 'capture-session-1',
        lensGeneration: 'front-generation-1',
        intent: 'talking-head',
      }, 'lens-changed');

    assert.equal(terminal.status, mode === 'cancel' ? 'cancelled' : 'stale');
    assert.equal(controller.getDiagnostics().starts, 1);
    assert.equal(controller.getDiagnostics().evaluations, 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(evaluatorCalls, 0);
    assert.equal(controller.getDiagnostics().evaluations, 0);
  }
});

test('a lens or session generation change makes a late result stale', async () => {
  const pending = deferred();
  const controller = createSuggestionJobController({ evaluator: () => pending.promise });

  const loading = controller.start(request());
  const stale = controller.invalidate({
    sessionId: 'session-2',
    lensGeneration: 'front-generation-1',
    intent: 'talking-head',
  }, 'camera-changed');

  assert.equal(stale.status, 'stale');
  assert.equal(stale.jobId, loading.jobId);
  pending.resolve(allGood('Late result must be ignored.'));
  await controller.whenSettled();
  await Promise.resolve();
  assert.equal(controller.getSnapshot().status, 'stale');
});

test('cancellation aborts a bounded request and a late result cannot revive it', async () => {
  const pending = deferred();
  let aborted = false;
  const controller = createSuggestionJobController({
    evaluator: (_request, context) => {
      context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return pending.promise;
    },
  });

  controller.start(request());
  await Promise.resolve();
  const cancelled = controller.cancel('stop');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'stop');
  assert.equal(aborted, true);
  pending.resolve(allGood());
  await controller.whenSettled();
  assert.equal(controller.getSnapshot().status, 'cancelled');
});

test('a slow evaluator is bounded and reports unavailable without fake progress', async () => {
  let observedSignal;
  const controller = createSuggestionJobController({
    timeoutMs: 5,
    evaluator: (_request, context) => {
      observedSignal = context.signal;
      return new Promise(() => {});
    },
  });

  controller.start(request());
  await controller.whenSettled();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.evaluation?.kind, 'unavailable');
  assert.equal(snapshot.evaluation?.reason, 'timeout');
  assert.equal(observedSignal.aborted, true);
  assert.equal(controller.getDiagnostics().timeouts, 1);
});

test('retry creates a fresh bounded job only after an unavailable result', async () => {
  let evaluations = 0;
  const controller = createSuggestionJobController({
    evaluator: async () => {
      evaluations += 1;
      return {
        kind: 'unavailable',
        reason: 'uncalibrated-evidence',
        message: 'Face presence alone cannot verify visual composition.',
        unsupportedCategories: ['lighting', 'camera-angle', 'exposure', 'background'],
      };
    },
  });

  controller.start(request());
  await controller.whenSettled();
  const firstJobId = controller.getSnapshot().jobId;
  assert.equal(controller.getSnapshot().status, 'unavailable');
  controller.retry();
  await controller.whenSettled();
  assert.equal(controller.getSnapshot().status, 'unavailable');
  assert.notEqual(controller.getSnapshot().jobId, firstJobId);
  assert.equal(evaluations, 2);
});

test('retry after a lens change does not relabel old evidence as current', async () => {
  const controller = createSuggestionJobController({
    now: () => 1_000,
  });
  const oldEvidence = {
    status: 'ready',
    frameCapturedAtMs: 950,
    observations: {},
  };

  controller.start(request({ evidence: oldEvidence }));
  await controller.whenSettled();
  controller.invalidate({
    sessionId: 'capture-session-1',
    lensGeneration: 'front-generation-2',
    intent: 'talking-head',
  }, 'lens-changed');
  controller.retry();
  await controller.whenSettled();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.request?.lensGeneration, 'front-generation-2');
  assert.equal(snapshot.request?.evidence, undefined);
  assert.equal(snapshot.evaluation?.kind, 'unavailable');
  assert.equal(snapshot.evaluation?.reason, 'vision-unavailable');
});

test('the default evaluator never upgrades face presence into calibrated advice', () => {
  const result = evaluateSuggestionRequest(request({
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 950,
      observations: {},
    },
  }));

  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'uncalibrated-evidence');
  assert.match(result.message, /face presence alone/i);
  assert.ok(result.unsupportedCategories.includes('framing'));
  assert.ok(result.unsupportedCategories.includes('lighting'));
});

test('calibrated fixture evidence can produce all-good while naming unsupported categories', () => {
  const result = evaluateSuggestionRequest(request({
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 950,
      observations: {
        'face-clipping': measured('clear', 'selected-face', 1_000),
        backlight: measured('clear', 'selected-face', 1_000),
        'background-distraction': measured('clear', 'selected-face', 1_000),
      },
    },
  }));

  assert.equal(result.kind, 'all-good');
  assert.deepEqual(result.unsupportedCategories, ['camera-angle', 'exposure']);
});

test('an actionable cue preserves every unsupported category for honest follow-up', () => {
  const result = evaluateSuggestionRequest(request({
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 950,
      observations: {
        'face-clipping': measured('issue', 'selected-face', 1_500),
        backlight: { state: 'unsupported', reason: 'camera-calibration-pending' },
        'background-distraction': { state: 'unsupported', reason: 'camera-calibration-pending' },
      },
    },
  }));

  assert.equal(result.kind, 'actionable');
  assert.equal(result.cue, 'face-clipping');
  assert.deepEqual(result.unsupportedCategories, ['lighting', 'background', 'camera-angle', 'exposure']);
});

test('face clipping below the calibrated confidence floor stays unavailable', () => {
  const result = evaluateSuggestionRequest(request({
    evidence: {
      status: 'ready',
      frameCapturedAtMs: 950,
      observations: {
        'face-clipping': measured('issue', 'selected-face', 1_500, 0.89),
        backlight: measured('clear', 'selected-face', 1_000),
        'background-distraction': measured('clear', 'selected-face', 1_000),
      },
    },
  }));

  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'uncalibrated-evidence');
  assert.ok(result.unsupportedCategories.includes('framing'));
});

test('intentional framing is an explicit off result without an image-quality claim', () => {
  const result = evaluateSuggestionRequest(request({ intent: 'intentional-look' }));

  assert.deepEqual(result, {
    kind: 'intentional',
    message: 'Intentional framing selected. Automatic suggestions are off.',
    evidence: { source: 'none', calibrated: false },
  });
});

test('completion does not start another job until the creator taps again', async () => {
  let evaluations = 0;
  const controller = createSuggestionJobController({
    evaluator: async () => {
      evaluations += 1;
      return allGood();
    },
  });

  controller.start(request());
  await controller.whenSettled();
  controller.bind({ ...request(), requestedAtMs: undefined });
  assert.equal(evaluations, 1);
  assert.equal(controller.getDiagnostics().starts, 1);
});

test('malformed evaluator payloads stay unavailable rather than crashing presentation', async () => {
  for (const value of [
    { kind: 'all-good', message: 'Looks good' },
    { ...allGood(), unsupportedCategories: 'lighting' },
    { ...allGood(), evidence: { source: 'none', calibrated: false } },
    { kind: 'unavailable', reason: 'unknown', message: 'Unavailable', unsupportedCategories: ['invented-category'] },
  ]) {
    const controller = createSuggestionJobController({ evaluator: async () => value });
    controller.start(request());
    await controller.whenSettled();
    assert.equal(controller.getSnapshot().status, 'unavailable');
    assert.equal(controller.getSnapshot().evaluation.reason, 'evaluator-error');
  }
});

test('same-lens retry never replays an old frame and accepts a fresh snapshot explicitly', async () => {
  let clock = 2000;
  const seen = [];
  const controller = createSuggestionJobController({ now: () => clock, evaluator: request => {
    seen.push(request.evidence);
    return evaluateSuggestionRequest(request);
  } });
  controller.start(request({ requestedAtMs: 2000, evidence: { status: 'ready', frameCapturedAtMs: 0, observations: {} } }));
  await controller.whenSettled();
  controller.retry();
  await controller.whenSettled();
  assert.equal(seen[1], undefined);
  const fresh = { status: 'ready', frameCapturedAtMs: 2000, observations: {} };
  controller.retry(fresh);
  await controller.whenSettled();
  assert.equal(seen[2], fresh);
});
