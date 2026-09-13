import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMustSayMetadata,
  deserializeMustSayMetadata,
  evaluateMustSay,
  isCurrentMustSayEvidence,
  normalizeMustSayText,
  reconcileMustSayMetadata,
  serializeMustSayMetadata,
  setMustSayEnabled,
  mustSayToggleLabel,
} from '../src/features/speech-control/must-say.ts';

function line(id, text, spokenText = text) {
  return { id, text, spokenText };
}

function segment(id, text, overrides = {}) {
  return {
    id,
    text,
    isFinal: true,
    t0: 0,
    t1: 1,
    takeId: `${id}:take`,
    mediaUri: `file:///tmp/${id}.mp4`,
    playable: true,
    quality: 'clean',
    requirementRevisions: { 'line-1': 0 },
    ...overrides,
  };
}

test('safe normalization removes surface punctuation but does not alias or paraphrase wording', () => {
  assert.equal(normalizeMustSayText('Open AI released Pixel nine!'), 'open ai released pixel nine');
  assert.notEqual(normalizeMustSayText('1.5 percent'), normalizeMustSayText('15 percent'));
  assert.notEqual(normalizeMustSayText("Do not publish this"), normalizeMustSayText("Don't publish this"));
  assert.notEqual(normalizeMustSayText('5%'), normalizeMustSayText('5'));
  assert.notEqual(normalizeMustSayText('$5'), normalizeMustSayText('5'));
  assert.notEqual(normalizeMustSayText('-5'), normalizeMustSayText('5'));
  assert.notEqual(normalizeMustSayText('1/2'), normalizeMustSayText('1 2'));

  const metadata = createMustSayMetadata([
    line('line-1', 'Disclose the sponsored relationship. [look at camera]', 'Disclose the sponsored relationship.'),
  ]);
  const enabled = setMustSayEnabled(metadata, 'line-1', true);

  assert.equal(evaluateMustSay(enabled.requirements[0], {
    segments: [segment('take-1', 'Disclose the sponsored relationship!')],
  }).status, 'covered');
  assert.equal(evaluateMustSay(enabled.requirements[0], {
    segments: [segment('take-2', 'Mention the sponsored relationship!')],
    recognitionStatus: 'ready',
  }).status, 'needed');
  assert.equal(evaluateMustSay(
    setMustSayEnabled(createMustSayMetadata([line('line-2', 'Publish this.')] ), 'line-2', true).requirements[0],
    { segments: [segment('take-3', 'Do not publish this.')], recognitionStatus: 'ready' },
  ).status, 'needed');
});

test('only raw final speech can satisfy a must-say requirement', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the exact disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  const result = evaluateMustSay(requirement, {
    segments: [segment('segment-1', 'Say the wrong caption.', {
      manualCorrection: 'Say the exact disclosure.',
    })],
    recognitionStatus: 'ready',
  });

  assert.equal(result.status, 'needed');
  assert.deepEqual(result.evidence, null);
  assert.match(result.reason, /final raw/i);
});

test('a provisional exact read stays pending until final recognition arrives', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the exact disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  const result = evaluateMustSay(requirement, {
    segments: [segment('segment-1', 'Say the exact disclosure.', { isFinal: false })],
    recognitionStatus: 'listening',
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.evidence?.source, 'provisional-raw');
  assert.deepEqual(result.evidence?.segmentIds, ['segment-1']);
});

test('surrounding words are accepted only when capture explicitly links a multi-line utterance', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  assert.equal(evaluateMustSay(requirement, {
    segments: [segment('unscoped', 'Intro. Say the disclosure. Outro.')],
    recognitionStatus: 'ready',
  }).status, 'needed');
  assert.equal(evaluateMustSay(requirement, {
    segments: [segment('declared-only', 'Intro. Say the disclosure. Outro.', { lineIds: ['line-0', 'line-1'] })],
    recognitionStatus: 'ready',
  }).status, 'needed');
  assert.equal(evaluateMustSay(requirement, {
    segments: [segment('multi-line', 'Intro. Say the disclosure. Outro.', {
      lineIds: ['line-0', 'line-1'],
      scriptContext: {
        lineIds: ['line-0', 'line-1'],
        normalizedText: 'Intro. Say the disclosure. Outro.',
      },
    })],
    recognitionStatus: 'ready',
  }).status, 'covered');
});

test('a line edit and revert cannot reuse evidence captured for an older revision', () => {
  const first = createMustSayMetadata([line('line-1', 'Say the disclosure.')]);
  const required = setMustSayEnabled(first, 'line-1', true).requirements[0];
  const oldRead = segment('old-read', 'Say the disclosure.');
  assert.equal(evaluateMustSay(required, { segments: [oldRead], recognitionStatus: 'ready' }).status, 'covered');

  const edited = reconcileMustSayMetadata(first, [line('line-1', 'Say the revised disclosure.')]);
  const reverted = reconcileMustSayMetadata(edited, [line('line-1', 'Say the disclosure.')]);
  const result = evaluateMustSay(
    setMustSayEnabled(reverted, 'line-1', true).requirements[0],
    { segments: [oldRead], recognitionStatus: 'ready' },
  );

  assert.equal(result.revision, 2);
  assert.equal(result.status, 'needed');
  assert.equal(result.evidence?.requirementRevision, 0);
  assert.equal(isCurrentMustSayEvidence(reverted.requirements[0], result.evidence), false);
  assert.match(result.reason, /older wording revision/i);
});

test('an exact final phrase without playable clean media stays unresolved', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the exact disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  const result = evaluateMustSay(requirement, {
    segments: [segment('segment-1', 'Say the exact disclosure.', { playable: false })],
    recognitionStatus: 'ready',
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.evidence?.source, 'final-raw');
  assert.match(result.reason, /playable/i);
});

test('final wording without an explicit take identity stays unresolved', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the exact disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  const result = evaluateMustSay(requirement, {
    segments: [segment('segment-1', 'Say the exact disclosure.', { takeId: undefined })],
    recognitionStatus: 'ready',
  });

  assert.equal(result.status, 'pending');
  assert.match(result.reason, /explicit playable clean media/i);
});

test('a later clean take can satisfy the line after an earlier scratched matching take', () => {
  const requirement = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say the exact disclosure.')]),
    'line-1',
    true,
  ).requirements[0];

  const result = evaluateMustSay(requirement, {
    segments: [
      segment('scratched', 'Say the exact disclosure.', { quality: 'scratched' }),
      segment('clean', 'Say the exact disclosure.', { takeId: 'take-clean' }),
    ],
    recognitionStatus: 'ready',
  });

  assert.equal(result.status, 'covered');
  assert.deepEqual(result.evidence?.segmentIds, ['clean']);
  assert.equal(result.evidence?.requirementRevision, requirement.revision);
  assert.equal(isCurrentMustSayEvidence(requirement, result.evidence), true);
  assert.equal(isCurrentMustSayEvidence({ ...requirement, revision: requirement.revision + 1 }, result.evidence), false);
});

test('metadata follows stable line ids, archives deleted lines, and invalidates changed wording', () => {
  const first = createMustSayMetadata([
    line('line-1', 'First line.'),
    line('line-2', 'Required disclosure.'),
  ]);
  const marked = setMustSayEnabled(first, 'line-2', true);
  const revised = reconcileMustSayMetadata(marked, [
    line('line-2', 'A revised required disclosure.'),
    line('line-1', 'First line.'),
    line('line-3', 'A replacement line.'),
  ]);

  const required = revised.requirements.find((entry) => entry.lineId === 'line-2');
  assert.equal(required?.enabled, true);
  assert.equal(required?.requiredText, 'A revised required disclosure.');
  assert.equal(required?.revision, 1);
  assert.equal(revised.requirements.find((entry) => entry.lineId === 'line-3')?.enabled, false);
  assert.equal(revised.archived.length, 0);

  const deleted = reconcileMustSayMetadata(revised, [line('line-1', 'First line.')]);
  assert.equal(deleted.requirements.some((entry) => entry.lineId === 'line-2'), false);
  assert.equal(deleted.archived.find((entry) => entry.lineId === 'line-2')?.enabled, true);

  const replacement = reconcileMustSayMetadata(deleted, [
    line('line-1', 'First line.'),
    line('line-4', 'A revised required disclosure.'),
  ]);
  assert.equal(replacement.requirements.find((entry) => entry.lineId === 'line-4')?.enabled, false);
});

test('serialization round trips metadata and malformed present data fails closed', () => {
  const metadata = setMustSayEnabled(
    createMustSayMetadata([line('line-1', 'Say this.')]),
    'line-1',
    true,
  );
  const restored = deserializeMustSayMetadata(serializeMustSayMetadata(metadata));
  assert.deepEqual(restored, metadata);
  assert.throws(() => deserializeMustSayMetadata(JSON.stringify({ ...metadata, requirements: [{ ...metadata.requirements[0], revision: Number.MAX_SAFE_INTEGER + 1 }] })), /unreadable/);
  assert.equal(deserializeMustSayMetadata(null), null);
  assert.throws(() => deserializeMustSayMetadata(''), /unreadable/);
  assert.throws(() => deserializeMustSayMetadata('{"version":1}'), /must-say metadata/i);
  assert.throws(() => deserializeMustSayMetadata('{"version":99,"requirements":[],"archived":[]}'), /must-say metadata/i);
});

test('toggle labels expose optional, pending, covered and unavailable states', () => {
  assert.equal(mustSayToggleLabel(false), 'Must-say off');
  assert.equal(mustSayToggleLabel(true, 'pending'), 'Must-say required · checking recognition');
  assert.equal(mustSayToggleLabel(true, 'covered'), 'Must-say covered');
  assert.equal(mustSayToggleLabel(true, 'unavailable'), 'Must-say unavailable · review required');
});


test('stale raw evidence is not relabeled with the current requirement revision', () => {
  const requirement = { lineId: 'line-1', enabled: true, requiredText: 'Required words.', revision: 2 };
  const result = evaluateMustSay(requirement, { segments: [segment('old', 'Required words.', {
    requirementRevisions: { 'line-1': 0 },
  })], recognitionStatus: 'ready' });
  assert.equal(result.status, 'needed');
  assert.equal(result.evidence.requirementRevision, 0);
  assert.equal(isCurrentMustSayEvidence(requirement, result.evidence), false);
});

test('merged script document ids carry must-say intent through edits, reorder and serialized reopen', async () => {
  const { parseScript, moveLine, serializeScriptDocument, restoreScriptDocument } = await import('../src/lib/script-lines.ts');
  let document = parseScript('First line.\nThis is sponsored. [show product]');
  const disclosure = document.lines.find(line => line.spokenText === 'This is sponsored.');
  let metadata = setMustSayEnabled(createMustSayMetadata(document.lines), disclosure.id, true);
  document = moveLine(document, disclosure.id, -1);
  metadata = reconcileMustSayMetadata(metadata, document.lines);
  assert.equal(metadata.requirements.find(item => item.lineId === disclosure.id).enabled, true);
  document = parseScript(document.text.replace('This is sponsored.', 'This video is sponsored.'), document);
  metadata = reconcileMustSayMetadata(metadata, document.lines);
  assert.equal(metadata.requirements.find(item => item.lineId === disclosure.id).revision, 1);
  const reopened = restoreScriptDocument(document.text, serializeScriptDocument(document));
  const restored = reconcileMustSayMetadata(deserializeMustSayMetadata(serializeMustSayMetadata(metadata)), reopened.lines);
  assert.deepEqual(restored, metadata);
  assert.equal(restored.requirements.find(item => item.lineId === disclosure.id).requiredText, 'This video is sponsored.');
});


test('current provisional speech stays pending beside an old matching final read', () => {
  const requirement = { lineId: 'line-1', enabled: true, requiredText: 'Required words.', revision: 2 };
  const result = evaluateMustSay(requirement, { segments: [
    segment('old', 'Required words.', { requirementRevisions: { 'line-1': 0 } }),
    segment('current', 'Required words.', { isFinal: false, requirementRevisions: { 'line-1': 2 } }),
  ], recognitionStatus: 'listening' });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.evidence.segmentIds, ['current']);
  assert.equal(result.evidence.requirementRevision, 2);
});
