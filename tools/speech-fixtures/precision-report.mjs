/**
 * Coverage verdict precision report.
 *
 * This runs the deterministic coverage scenarios and the synthetic speech
 * fixture rows through the real coverage domain and reports precision and
 * recall per verdict.
 *
 * The fixture rows are synthetic. They contain no recorded audio and no user
 * transcript, so this report is not a human accuracy measurement and must not
 * be quoted as one.
 */

import { readFileSync } from 'node:fs';

import { createScenario, runScenario } from '../../src/development/coverage/scenarios.ts';
import { coverageLedger } from '../../src/lib/coverage-updates.ts';
import {
  createScriptLine,
  createTranscriptSegment,
  deriveReviewState,
} from '../../src/lib/transcript-workflow.ts';

const LABEL_HEADER = 'synthetic fixtures, not human held-out data';
const SCENARIO_IDS = ['clean', 'flub-reread'];
const VERDICTS = ['covered', 'pending', 'needed'];

/** A flubbed read must not cover its line; every other label is a full read. */
function expectedVerdict(label) {
  return label === 'flub' ? 'needed' : 'covered';
}

function readFixtureRows(url) {
  return readFileSync(url, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => JSON.parse(line));
}

/**
 * Derive the coverage verdict for one fixture row.  The take deliberately
 * declares no line ids, so only a whole-utterance match can cover the line.
 */
function verdictForRow(row) {
  const line = createScriptLine({ id: 'line-1', text: row.reference });
  const segment = createTranscriptSegment({
    id: `${row.id}:utterance`,
    t0: 0,
    t1: 1,
    text: row.hypothesis,
    isFinal: true,
    revision: 1,
  });
  const review = deriveReviewState({
    lines: [line],
    segments: [segment],
    takes: [{
      id: `${row.id}:take`,
      t0: 0,
      t1: 1,
      mediaUri: `file:///fixtures/${row.id}.mp4`,
      playable: true,
      quality: 'clean',
      inFrame: true,
      transcriptSegmentIds: [segment.id],
    }],
  });
  return coverageLedger(review).entries[0];
}

function scoreVerdicts(rows) {
  const counts = new Map(VERDICTS.map((verdict) => [verdict, { predicted: 0, expected: 0, correct: 0 }]));
  const mismatches = [];

  for (const row of rows) {
    const entry = verdictForRow(row);
    const expected = expectedVerdict(row.label);
    counts.get(entry.status).predicted += 1;
    counts.get(expected).expected += 1;
    if (entry.status === expected) {
      counts.get(expected).correct += 1;
    } else {
      mismatches.push({ id: row.id, label: row.label, expected, actual: entry.status, reason: entry.reason });
    }
  }
  return { counts, mismatches };
}

function ratio(correct, total) {
  return total === 0 ? 'n/a' : (correct / total).toFixed(3);
}

function reportScenarios() {
  const failures = [];
  console.log('Scenario replay');
  for (const id of SCENARIO_IDS) {
    const scenario = createScenario(id);
    const first = runScenario(scenario);
    const second = runScenario(createScenario(id));
    const stable = JSON.stringify(first) === JSON.stringify(second);
    const asExpected = JSON.stringify(first.coverage) === JSON.stringify(scenario.expected.coverage)
      && JSON.stringify(first.cuts) === JSON.stringify(scenario.expected.cuts)
      && first.safeToWrap === scenario.expected.safeToWrap;
    if (!stable) failures.push(`${id}: two replays did not agree`);
    if (!asExpected) failures.push(`${id}: replay did not match the expected coverage or cut order`);

    console.log(`  ${id}: ${scenario.title}`);
    for (const entry of first.coverage) {
      console.log(`    ${entry.lineId}: ${entry.status} (${entry.reason}) take=${entry.selectedTakeId ?? 'none'}`);
    }
    console.log(`    cuts in script order: ${first.cuts.map((cut) => `${cut.takeId}[${cut.lineIds.join(', ')}]`).join(' -> ')}`);
    console.log(`    identical on replay: ${stable}; matches expectation: ${asExpected}`);
  }
  return failures;
}

function reportFixtures(rows) {
  const { counts, mismatches } = scoreVerdicts(rows);
  console.log('');
  console.log(`Fixture rows: ${rows.length} (${LABEL_HEADER})`);
  console.log('  verdict   predicted  expected  correct  precision  recall');
  for (const verdict of VERDICTS) {
    const { predicted, expected, correct } = counts.get(verdict);
    console.log([
      `  ${verdict.padEnd(10)}`,
      String(predicted).padStart(9),
      String(expected).padStart(10),
      String(correct).padStart(9),
      ratio(correct, predicted).padStart(11),
      ratio(correct, expected).padStart(8),
    ].join(''));
  }

  for (const mismatch of mismatches) {
    console.log(`  mismatch ${mismatch.id} (${mismatch.label}): expected ${mismatch.expected}, got ${mismatch.actual} (${mismatch.reason})`);
  }
  return mismatches.map((mismatch) => `${mismatch.id}: expected ${mismatch.expected}, got ${mismatch.actual}`);
}

function reportEligibility(rows) {
  const heldOut = rows.filter((row) => row.split === 'heldout');
  const consented = heldOut.filter((row) => row.consented === true);
  const clean = consented.filter((row) => row.label !== 'flub').length;
  const flub = consented.filter((row) => row.label === 'flub').length;
  console.log('');
  console.log('Held-out eligibility');
  console.log(`  held-out rows: ${heldOut.length}; consented human rows: ${consented.length}`);
  console.log(`  eligible clean rows: ${clean} of 60 required; eligible flub rows: ${flub} of 30 required`);
  console.log('  This report is synthetic and remains ineligible for a design-target accuracy claim.');
}

const rows = readFixtureRows(new URL('./synthetic-small.jsonl', import.meta.url));
console.log(`Coverage verdict report (${LABEL_HEADER})`);
console.log('');
const failures = [...reportScenarios(), ...reportFixtures(rows)];
reportEligibility(rows);
console.log('');

if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASSED ${SCENARIO_IDS.length} scenarios and ${rows.length} synthetic fixture rows.`);
}
