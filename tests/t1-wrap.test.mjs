import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWrapReport, acknowledgeWrapAnyway, clearWrapAcknowledgement, formatWrapElapsed } from '../src/lib/t1-wrap.ts';

const fixture = JSON.parse(readFileSync(new URL('../tools/fixtures/t1-wrap.json', import.meta.url), 'utf8'));

function project(overrides = {}) {
  return structuredClone({ ...fixture, ...overrides });
}

test('all-covered fixture reports conservative coverage, supplied must-say evidence, takes, and exact timing', () => {
  const report = buildWrapReport(project());

  assert.equal(report.projectId, 'wrap-fixture');
  assert.equal(report.evidenceStatus, 'available');
  assert.equal(report.evidenceProvider, 'fixture');
  assert.equal(report.qualifiedAllClear, true);
  assert.equal(report.wrapAllowed, true);
  assert.equal(report.recordingToWrapMs, 10333);
  assert.deepEqual(report.lines.map(line => [line.id, line.coverage, line.mustSay.status, line.takeCount]), [
    ['line-1', 'covered', 'satisfied', 1],
    ['line-2', 'covered', 'satisfied', 1],
  ]);
  assert.equal(report.lines[0].evidence[0].recordingId, 'wrap-fixture');
  assert.deepEqual(report.actions.map(action => [action.id, action.required, action.confirmed]), [
    ['action-required', true, true],
    ['action-optional', false, false],
  ]);
  assert.deepEqual(report.currentFlagIds, []);
});

test('must-say missing blocks all-clear even when baseline spoken coverage is covered', () => {
  const input = project();
  input.tier1Evidence.mustSay[1].status = 'missing';
  const report = buildWrapReport(input);

  assert.equal(report.lines[1].coverage, 'covered');
  assert.equal(report.lines[1].mustSay.status, 'missing');
  assert.equal(report.qualifiedAllClear, false);
  assert.ok(report.currentFlagIds.includes('must-say:line-2'));

  const acknowledged = acknowledgeWrapAnyway(input, 1778700020000);
  const acknowledgedReport = buildWrapReport(acknowledged);
  assert.equal(acknowledgedReport.wrapAllowed, true);
  assert.equal(acknowledgedReport.acknowledgementValid, true);
  assert.deepEqual(acknowledged.wrapAcknowledgement.remainingFlags, ['must-say:line-2']);
  assert.ok(acknowledgedReport.remainingFlags.includes('must-say:line-2'));

  acknowledged.tier1Evidence.mustSay[1].status = 'satisfied';
  acknowledged.tier1Evidence.revision = 'fixture-r2';
  const changed = buildWrapReport(acknowledged);
  assert.equal(changed.acknowledgementValid, false);
  assert.equal(changed.wrapAllowed, false);
  assert.ok(changed.remainingFlags.includes('must-say:line-2'));
});

test('pending evidence remains pending and cannot produce an unqualified all-clear', () => {
  const input = project();
  input.tier1Evidence.status = 'pending';
  input.tier1Evidence.mustSay[1].status = 'pending';
  const report = buildWrapReport(input);

  assert.equal(report.evidenceStatus, 'pending');
  assert.equal(report.lines[1].mustSay.status, 'pending');
  assert.equal(report.qualifiedAllClear, false);
  assert.equal(report.wrapAllowed, false);
  assert.ok(report.currentFlagIds.includes('evidence:pending'));
  assert.ok(report.currentFlagIds.includes('must-say:line-2'));

  const acknowledged = acknowledgeWrapAnyway(input, 1778700021000);
  const acknowledgedReport = buildWrapReport(acknowledged);
  assert.equal(acknowledgedReport.qualifiedAllClear, false);
  assert.equal(acknowledgedReport.acknowledgementValid, true);
  assert.equal(acknowledgedReport.wrapAllowed, true);
  assert.ok(acknowledgedReport.remainingFlags.includes('evidence:pending'));
});

test('required actions remain separate from speech and only manual confirmation resolves them', () => {
  const input = project();
  input.scriptLines[1].actionCues[0].resolved = false;
  const report = buildWrapReport(input);

  assert.equal(report.lines.every(line => line.coverage === 'covered'), true);
  assert.equal(report.actions.find(action => action.id === 'action-required').confirmed, false);
  assert.equal(report.actions.find(action => action.id === 'action-optional').blocksWrap, false);
  assert.ok(report.currentFlagIds.includes('action:action-required'));
  assert.equal(report.currentFlagIds.includes('action:action-optional'), false);

  input.scriptLines[1].actionCues[0].resolved = true;
  const resolved = buildWrapReport(input);
  assert.equal(resolved.actions.find(action => action.id === 'action-required').confirmed, true);
  assert.equal(resolved.currentFlagIds.includes('action:action-required'), false);
});

test('optional action-only lines stay out of speech coverage while their action remains visible', () => {
  const input = project();
  input.scriptLines.push({
    id: 'line:action-only',
    spokenText: '',
    actionCues: [{ id: 'action-optional-only', text: 'Smile at the camera', required: false, resolved: false }],
  });

  const report = buildWrapReport(input);

  assert.deepEqual(report.lines.map(line => line.id), ['line-1', 'line-2']);
  assert.deepEqual(report.optionalActions.find(action => action.id === 'action-optional-only'), {
    id: 'action-optional-only',
    text: 'Smile at the camera',
    required: false,
    confirmed: false,
    status: 'unresolved',
    blocksWrap: false,
  });
  assert.equal(report.currentFlagIds.includes('coverage:line:action-only'), false);
  assert.equal(report.currentFlagIds.includes('must-say:line:action-only'), false);
  assert.equal(report.qualifiedAllClear, true);
});

test('flag lookup preserves line IDs that contain colons', () => {
  const input = project();
  input.scriptLines[1].id = 'section:line:0';
  input.tier1Evidence.scriptSnapshot[1].lineId = 'section:line:0';
  input.tier1Evidence.mustSay[1].lineId = 'section:line:0';
  input.tier1Evidence.mustSay[1].status = 'missing';

  const report = buildWrapReport(input);
  const flag = report.flags.find(candidate => candidate.id === 'must-say:section:line:0');

  assert.ok(flag);
  assert.equal(flag.lineId, 'section:line:0');
  assert.match(flag.message, /Say it simply/);
});

test('missing media never appears playable or covered', () => {
  const input = project({ mediaMissing: true });
  const report = buildWrapReport(input);

  assert.equal(report.mediaAvailable, false);
  assert.equal(report.lines.every(line => line.coverage !== 'covered'), true);
  assert.equal(report.lines[0].evidence[0].playable, false);
  assert.equal(report.qualifiedAllClear, false);
  assert.ok(report.currentFlagIds.includes('coverage:line-1'));
  assert.ok(report.currentFlagIds.includes('coverage:line-2'));
});

test('malformed or project-mismatched evidence fails closed without throwing', () => {
  for (const evidence of [
    { ...fixture.tier1Evidence, projectId: 'another-project' },
    { ...fixture.tier1Evidence, revision: '' },
    { ...fixture.tier1Evidence, mustSay: [{ lineId: 'unknown-line', required: true, status: 'satisfied', evidence: [] }] },
    { ...fixture.tier1Evidence, mustSay: [{ lineId: 'line-1', required: true, status: 'satisfied', evidence: [{ recordingId: 'wrap-fixture', t0: 3, t1: 2 }] }, fixture.tier1Evidence.mustSay[1]] },
  ]) {
    const report = buildWrapReport(project({ tier1Evidence: evidence }));
    assert.equal(report.qualifiedAllClear, false);
    assert.equal(report.wrapAllowed, false);
    assert.equal(report.evidenceStatus, 'unavailable');
    assert.ok(report.evidenceError);
  }
});

test('missing or stale script snapshots cannot produce an all-clear', () => {
  const missing = project();
  delete missing.tier1Evidence.scriptSnapshot;
  const missingReport = buildWrapReport(missing);
  assert.equal(missingReport.qualifiedAllClear, false);
  assert.equal(missingReport.wrapAllowed, false);
  assert.match(missingReport.evidenceError, /script snapshot/i);

  const changed = project();
  changed.scriptLines[0].spokenText = 'A changed line with the same identity.';
  const changedReport = buildWrapReport(changed);
  assert.equal(changedReport.qualifiedAllClear, false);
  assert.equal(changedReport.wrapAllowed, false);
  assert.match(changedReport.evidenceError, /script snapshot/i);
});

test('changing wording invalidates an existing Wrap anyway acknowledgement', () => {
  const input = project();
  input.tier1Evidence.mustSay[1].status = 'missing';
  const acknowledged = acknowledgeWrapAnyway(input, 1778700030000);
  acknowledged.scriptLines[1].spokenText = 'A changed line with the same identity.';
  const report = buildWrapReport(acknowledged);

  assert.equal(report.acknowledgementValid, false);
  assert.equal(report.wrapAllowed, false);
  assert.equal(report.evidenceRevision, null);
  assert.ok(report.remainingFlags.includes('evidence:unavailable'));
});

test('changing source identity or action semantics invalidates a prior acknowledgement', () => {
  const mutations = [
    (input) => { input.videoUri = 'file:///replacement.mp4'; },
    (input) => { input.recordings = [{ id: 'pickup-1', mediaUri: 'file:///pickup.mp4', duration: 7, createdAt: 2 }]; },
    (input) => { input.availableMediaUris = ['file:///replacement.mp4']; },
    (input) => { input.unavailableTakeIds = ['take:segment-2']; },
    (input) => { input.scriptLines[1].actionCues[0].text = 'Show the back label'; },
    (input) => { input.scriptLines[1].actionCues[0].required = false; },
    (input) => { input.scriptLines[1].actionCues[0].id = 'action-required-replaced'; },
  ];

  for (const mutate of mutations) {
    const input = project();
    input.tier1Evidence.mustSay[1].status = 'missing';
    const acknowledged = acknowledgeWrapAnyway(input, 1778700040000);
    mutate(acknowledged);
    const report = buildWrapReport(acknowledged);
    assert.equal(report.acknowledgementValid, false);
    assert.equal(report.wrapAllowed, false);
    assert.ok(report.remainingFlags.includes('acknowledgement:stale'));
  }
});

test('multi-source evidence links resolve pickup footage while an unavailable primary stays unplayable', () => {
  const input = project({
    mediaMissing: true,
    recordings: [{ id: 'pickup-1', mediaUri: 'file:///pickup.mp4', duration: 7, createdAt: 2, evidenceStatus: 'complete' }],
    availableMediaUris: ['file:///pickup.mp4'],
    takes: [{
      id: 'pickup-take-2',
      t0: 4.1,
      t1: 6.6,
      mediaUri: 'file:///pickup.mp4',
      playable: true,
      quality: 'clean',
      inFrame: false,
      transcriptSegmentIds: ['segment-2'],
      eligibleLineIds: ['line-2'],
    }],
  });
  input.tier1Evidence.mustSay[0].evidence = [{ recordingId: 'wrap-fixture', t0: 1.2, t1: 3.8 }];
  input.tier1Evidence.mustSay[1].evidence = [{ recordingId: 'pickup-1', t0: 4.1, t1: 6.6 }];

  const report = buildWrapReport(input);
  const line1 = report.lines.find(line => line.id === 'line-1');
  const line2 = report.lines.find(line => line.id === 'line-2');
  assert.equal(report.mediaAvailable, true);
  assert.notEqual(line1.coverage, 'covered');
  assert.equal(line1.evidence[0].playable, false);
  assert.equal(line2.coverage, 'covered');
  assert.equal(line2.evidence[0].playable, true);
  assert.equal(report.qualifiedAllClear, false);
});

test('pending pickup evidence cannot appear playable or covered', () => {
  const input = project({
    recordings: [{ id: 'pickup-1', mediaUri: 'file:///pickup.mp4', duration: 7, createdAt: 2, evidenceStatus: 'pending' }],
    availableMediaUris: ['file:///pickup.mp4'],
    takes: [{
      id: 'pickup-take-2',
      t0: 4.1,
      t1: 6.6,
      mediaUri: 'file:///pickup.mp4',
      playable: true,
      quality: 'clean',
      inFrame: false,
      transcriptSegmentIds: ['segment-2'],
      eligibleLineIds: ['line-2'],
    }],
  });
  input.tier1Evidence.mustSay[1].evidence = [{ recordingId: 'pickup-1', t0: 4.1, t1: 6.6 }];
  input.tier1Evidence.status = 'pending';

  const report = buildWrapReport(input);
  assert.notEqual(report.lines.find(line => line.id === 'line-2').coverage, 'covered');
  assert.equal(report.lines.find(line => line.id === 'line-2').evidence[0].playable, false);
  assert.equal(report.qualifiedAllClear, false);
});

test('legacy acknowledgements without context are retained as stale flags', () => {
  const input = project();
  input.tier1Evidence.mustSay[1].status = 'missing';
  const acknowledged = acknowledgeWrapAnyway(input, 1778700041000);
  delete acknowledged.wrapAcknowledgement.contextKey;
  const report = buildWrapReport(acknowledged);

  assert.equal(report.acknowledgementValid, false);
  assert.equal(report.wrapAllowed, false);
  assert.ok(report.remainingFlags.includes('acknowledgement:stale'));
  assert.equal(report.acknowledgement.contextKey, undefined);
});

test('omitted media state is unknown and cannot appear playable or covered', () => {
  const input = project();
  delete input.mediaMissing;
  const report = buildWrapReport(input);

  assert.equal(report.mediaAvailable, false);
  assert.equal(report.lines.every(line => line.coverage !== 'covered'), true);
  assert.equal(report.qualifiedAllClear, false);
});

test('unknown timing is explicit when capture omits either endpoint', () => {
  const input = project();
  delete input.tier1Evidence.wrapRequestedAt;
  const report = buildWrapReport(input);

  assert.equal(report.recordingToWrapMs, null);
  assert.equal(report.recordingToWrapLabel, 'Unknown');
});

test('clearing a stale acknowledgement starts a fresh review and preserves exact elapsed formatting', () => {
  const input = project();
  input.tier1Evidence.mustSay[1].status = 'missing';
  const acknowledged = acknowledgeWrapAnyway(input, 1778700020000);
  acknowledged.tier1Evidence.mustSay[1].status = 'satisfied';
  acknowledged.tier1Evidence.revision = 'fixture-r2';
  const fresh = clearWrapAcknowledgement(acknowledged);

  assert.equal(fresh.wrapAcknowledgement, undefined);
  assert.equal(buildWrapReport(fresh).qualifiedAllClear, true);
  assert.equal(formatWrapElapsed(10333), '10.333s');
  assert.equal(formatWrapElapsed(null), 'Unknown');
});
