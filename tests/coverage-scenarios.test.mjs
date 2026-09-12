import assert from 'node:assert/strict';
import test from 'node:test';

import { createScenario, runScenario, scenarioIds } from '../src/development/coverage/scenarios.ts';

function coverageOf(result, lineId) {
  const found = result.coverage.find((item) => item.lineId === lineId);
  assert.ok(found, `expected coverage for ${lineId}`);
  return found;
}

function historyOf(result, lineId) {
  const found = result.history.find((item) => item.lineId === lineId);
  assert.ok(found, `expected take history for ${lineId}`);
  return found.takeIds;
}

for (const id of scenarioIds) {
  test(`scenario ${id} replays twice with identical coverage and cut order`, () => {
    const scenario = createScenario(id);
    const first = runScenario(scenario);
    const second = runScenario(createScenario(id));

    assert.deepEqual(second, first);
    assert.deepEqual(first.coverage, scenario.expected.coverage);
    assert.deepEqual(first.cuts, scenario.expected.cuts);
    assert.equal(first.safeToWrap, scenario.expected.safeToWrap);
    assert.ok(first.coverage.length > 0, 'a scenario must cover at least one script line');
  });
}

test('every selected cut plays in script order, never in recording order', () => {
  const result = runScenario(createScenario('out-of-order'));

  assert.deepEqual(result.coverage.map(({ lineId }) => lineId), ['line-1', 'line-2', 'line-3']);
  assert.deepEqual(result.cuts.map(({ takeId }) => takeId), ['take-a', 'take-b', 'take-c']);
  assert.deepEqual(result.cuts.map(({ t0 }) => t0), [5, 7, 1]);
});

test('a pending line stays pending however far the clock advances past the analysis timeout', () => {
  const scenario = createScenario('pending-timer');
  const immediate = runScenario(scenario, { nowSeconds: 0 });
  const muchLater = runScenario(scenario, { nowSeconds: 1_000_000 });

  assert.equal(coverageOf(immediate, 'line-2').status, 'pending');
  assert.equal(coverageOf(immediate, 'line-2').reason, 'provisional-transcript');
  assert.deepEqual(immediate.timedOutTakeIds, []);
  assert.deepEqual(muchLater.timedOutTakeIds, ['take-2']);
  assert.deepEqual(muchLater.coverage, immediate.coverage);
  assert.deepEqual(muchLater.cuts, immediate.cuts);
  assert.equal(muchLater.safeToWrap, false);

  const finalised = runScenario({
    ...scenario,
    segments: scenario.segments.map((segment) => ({ ...segment, isFinal: true })),
  }, { nowSeconds: 1_000_000 });
  assert.equal(coverageOf(finalised, 'line-2').status, 'covered');
  assert.equal(coverageOf(finalised, 'line-2').selectedTakeId, 'take-2');
});

test('a bad reread never erases an earlier clean take and never lands on the wrong line', () => {
  const result = runScenario(createScenario('flub-reread'));

  assert.equal(coverageOf(result, 'line-1').selectedTakeId, 'take-2');
  assert.equal(coverageOf(result, 'line-2').selectedTakeId, 'take-2');
  assert.deepEqual(historyOf(result, 'line-1'), ['take-1', 'take-2', 'take-3']);
  assert.deepEqual(historyOf(result, 'line-2'), ['take-1', 'take-2']);
  assert.deepEqual(result.cuts, [{ takeId: 'take-2', lineIds: ['line-1', 'line-2'], t0: 9, t1: 15.5 }]);
});

test('an off-frame or unobserved take loses to an otherwise suitable in-frame take taken later', () => {
  const result = runScenario(createScenario('off-frame-vs-in-frame'));

  assert.equal(coverageOf(result, 'line-1').selectedTakeId, 'in-frame-take');
  assert.deepEqual(historyOf(result, 'line-1'), ['off-frame-take', 'in-frame-take', 'unobserved-take']);
});

test('scratched takes are excluded from coverage and retained in history', () => {
  const result = runScenario(createScenario('scratched-take'));

  assert.equal(coverageOf(result, 'line-1').selectedTakeId, 'clean-take');
  assert.deepEqual(historyOf(result, 'line-1'), ['scratched-take', 'clean-take']);
  assert.equal(coverageOf(result, 'line-2').status, 'needed');
  assert.equal(coverageOf(result, 'line-2').reason, 'no-clean-take');
  assert.deepEqual(historyOf(result, 'line-2'), ['scratched-only-take']);
});

test('a take whose file disappears after recording moves its line back to needed', () => {
  const result = runScenario(createScenario('missing-file'));

  assert.equal(coverageOf(result, 'line-1').status, 'needed');
  assert.equal(coverageOf(result, 'line-1').reason, 'media-missing');
  assert.deepEqual(historyOf(result, 'line-1'), ['take-1']);
  assert.equal(coverageOf(result, 'line-2').reason, 'media-unavailable');
  assert.deepEqual(result.cuts, []);
});

test('editing, deleting and adding script lines updates coverage without discarding takes', () => {
  const result = runScenario(createScenario('script-edit-after-coverage'));

  assert.equal(coverageOf(result, 'line-1').status, 'needed');
  assert.equal(coverageOf(result, 'line-1').reason, 'script-edited');
  assert.deepEqual(historyOf(result, 'line-1'), ['take-1']);
  assert.equal(coverageOf(result, 'line-2').status, 'covered');
  assert.equal(coverageOf(result, 'line-4').reason, 'line-added');
  assert.deepEqual(result.retiredLineIds, ['line-3']);
  assert.equal(result.safeToWrap, false);
});

test('an unresolved required action cue blocks safe to wrap even when every line is covered', () => {
  const result = runScenario(createScenario('required-action'));

  assert.ok(result.coverage.every(({ status }) => status === 'covered'));
  assert.deepEqual(result.unresolvedRequiredActionCueIds, ['cue-product-label']);
  assert.equal(result.safeToWrap, false);
});

test('a clean read covers every line and keeps one cut per take', () => {
  const result = runScenario(createScenario('clean'));

  assert.ok(result.coverage.every(({ status }) => status === 'covered'));
  assert.equal(result.safeToWrap, true);
  assert.deepEqual(result.cuts.map(({ takeId }) => takeId), ['take-1', 'take-2']);
});

test('two lines read in one breath share a single unbroken cut', () => {
  const result = runScenario(createScenario('two-lines-one-breath'));

  assert.deepEqual(result.cuts, [{ takeId: 'take-1', lineIds: ['line-1', 'line-2'], t0: 0.5, t1: 8.5 }]);
  assert.equal(result.safeToWrap, true);
});
