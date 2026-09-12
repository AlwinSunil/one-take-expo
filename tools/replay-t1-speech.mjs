import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectScratchCommand } from '../src/features/speech-control/take-decisions.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/t1-commands.json', import.meta.url), 'utf8'));
assert.equal(fixture.synthetic, true);
const results = fixture.cases.map(item => {
  const command = detectScratchCommand({ ...item, ...fixture.scope }, { scriptText: item.scriptText });
  const detected = command !== null;
  assert.equal(detected, item.expectedCommand, item.id);
  return { id: item.id, expected: item.expectedCommand, detected,
    playbackExclusion: command?.commandInterval.playbackExclusion ?? null,
    safeForSplice: command?.commandInterval.safeForSplice ?? false };
});
console.log(JSON.stringify({ synthetic: true, humanAccuracyEvidence: false,
  cases: results.length,
  falseTriggers: results.filter(row => !row.expected && row.detected).length,
  missedCommands: results.filter(row => row.expected && !row.detected).length,
  results }, null, 2));
