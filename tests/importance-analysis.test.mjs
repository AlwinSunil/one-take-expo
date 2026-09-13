import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLineImportance, importantLineIds } from '../src/features/local-ai/importance-analysis.ts';
import { scriptPointChecks } from '../src/features/capture/script-point-checks.ts';
import { parseScript } from '../src/lib/script-lines.ts';

test('essential details cannot be suppressed by a greeting classification', async () => {
  let classifications = 0;
  const lines = [
    { id: 'hello', spokenText: 'Hello everyone!' },
    { id: 'price', spokenText: 'Hello, the price is $50' },
    { id: 'instruction', spokenText: 'Save your changes before closing' },
    { id: 'claim', spokenText: 'The camera records wonderful pictures.' },
  ];
  const selected = await importantLineIds(lines, async () => { classifications++; return 'Fact'; });
  assert.deepEqual(selected, ['price', 'instruction', 'claim']);
  assert.equal(classifications, 1);
});
test('social-only scripts can have no important points; unknown classifications remain visible', async () => {
  assert.deepEqual(await importantLineIds([{ id: 'hi', spokenText: 'Hi.' }, { id: 'bye', spokenText: 'Thanks for watching!' }], async () => { throw Error('No inference needed'); }), []);
  assert.deepEqual(await importantLineIds([{ id: 'claim', spokenText: 'The battery lasts throughout the journey.' }], async () => 'Uncertain'), ['claim']);
  assert.equal(clearLineImportance('Thank you. Download the app'), true);
});
test('basic checks flag essential unpunctuated lines while local analysis is pending', () => {
  const checks = scriptPointChecks(parseScript('Price $50\nSave before closing\nHello everyone'), []);
  assert.deepEqual(checks.map(c => c.text), ['Price $50', 'Save before closing']);
});
