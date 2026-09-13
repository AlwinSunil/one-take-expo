import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScriptDraftSnapshot,
  deserializeScriptDraftSnapshot,
  ScriptDraftSnapshotError,
  serializeScriptDraftSnapshot,
} from '../src/lib/t1-script-draft.ts';
import {
  moveLine,
  parseScript,
  serializeScriptDocument,
  setCueRequired,
  setCueStatus,
} from '../src/lib/script-lines.ts';
import {
  createMustSayMetadata,
  reconcileMustSayMetadata,
  setMustSayEnabled,
} from '../src/features/speech-control/must-say.ts';

function metadataFor(document) {
  return createMustSayMetadata(document.lines);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof ScriptDraftSnapshotError && error.code === code);
}

test('atomic snapshot preserves raw text, reordered line and cue identity, and must-say revisions', () => {
  let document = parseScript('Opening line.\nDisclose the sponsor. [show product]');
  const disclosure = document.lines[1];
  const cue = document.lines[2].actionCues[0];
  const actionLineId = document.lines[2].id;
  document = setCueStatus(setCueRequired(document, cue.id, true), cue.id, 'skipped');

  let metadata = setMustSayEnabled(metadataFor(document), disclosure.id, true);
  document = moveLine(document, disclosure.id, -1);
  metadata = reconcileMustSayMetadata(metadata, document.lines);
  document = parseScript(
    document.text.replace('Disclose the sponsor.', 'Disclose the paid sponsor.'),
    document,
  );
  metadata = reconcileMustSayMetadata(metadata, document.lines);
  const editedRequirement = metadata.requirements.find(entry => entry.lineId === disclosure.id);
  assert.equal(editedRequirement?.enabled, true);
  assert.equal(editedRequirement?.revision, 1);

  const snapshot = createScriptDraftSnapshot({ identity: 'project-1', document, mustSay: metadata });
  const restored = deserializeScriptDraftSnapshot(serializeScriptDraftSnapshot(snapshot), {
    expectedIdentity: 'project-1',
    expectedText: document.text,
  });

  assert.equal(restored.text, document.text);
  assert.deepEqual(restored.document.lines.map(line => line.id), document.lines.map(line => line.id));
  assert.deepEqual(restored.document.lines.map(line => line.text), document.lines.map(line => line.text));
  const restoredCue = restored.document.lines.find(line => line.id === actionLineId)?.actionCues[0];
  assert.deepEqual(restoredCue, {
    id: `${actionLineId}:cue:0`,
    text: 'show product',
    required: true,
    status: 'skipped',
  });
  assert.deepEqual(restored.mustSay, metadata);
});

test('snapshot reconciliation keeps enabled intent and increments a wording revision on restore', () => {
  const document = parseScript('Say the sponsor name.');
  const line = document.lines[0];
  const oldMetadata = setMustSayEnabled(metadataFor(document), line.id, true);
  const changedDocument = parseScript('Say the sponsor name clearly.', document);
  const snapshot = createScriptDraftSnapshot({
    identity: 'draft-1',
    document: changedDocument,
    mustSay: oldMetadata,
  });

  const restored = deserializeScriptDraftSnapshot(serializeScriptDraftSnapshot(snapshot));
  const requirement = restored.mustSay.requirements[0];
  assert.equal(requirement.lineId, line.id);
  assert.equal(requirement.enabled, true);
  assert.equal(requirement.requiredText, 'Say the sponsor name clearly.');
  assert.equal(requirement.revision, 1);
});

test('present malformed or stale structure and identity fail closed', () => {
  const document = parseScript('One line.');
  const metadata = metadataFor(document);
  const serialized = serializeScriptDraftSnapshot(createScriptDraftSnapshot({
    identity: 'project-1',
    document,
    mustSay: metadata,
  }));

  expectCode(() => deserializeScriptDraftSnapshot('not json'), 'malformed');
  expectCode(() => deserializeScriptDraftSnapshot(serialized, { expectedIdentity: 'project-2' }), 'identity-mismatch');
  expectCode(() => deserializeScriptDraftSnapshot(serialized, { expectedText: 'Different line.' }), 'text-mismatch');

  const stale = JSON.parse(serialized);
  const oldStructure = JSON.parse(stale.structure);
  oldStructure.lines[0].text = 'Old line.';
  stale.structure = JSON.stringify(oldStructure);
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(stale)), 'structure-mismatch');

  const staleMustSay = JSON.parse(serialized);
  const staleMetadata = JSON.parse(staleMustSay.mustSay);
  staleMetadata.requirements[0].requiredText = 'A different line.';
  staleMustSay.mustSay = JSON.stringify(staleMetadata);
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(staleMustSay)), 'must-say-mismatch');

  const unsupported = JSON.parse(serialized);
  unsupported.version = 99;
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(unsupported)), 'malformed');
});

test('missing enabled requirement never becomes a disabled requirement during restore', () => {
  const document = parseScript('The required disclosure.');
  const metadata = setMustSayEnabled(metadataFor(document), document.lines[0].id, true);
  const snapshot = JSON.parse(serializeScriptDraftSnapshot(createScriptDraftSnapshot({
    identity: 'project-1',
    document,
    mustSay: metadata,
  })));
  const mustSay = JSON.parse(snapshot.mustSay);
  mustSay.requirements = [];
  snapshot.mustSay = JSON.stringify(mustSay);
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(snapshot)), 'must-say-mismatch');

  const unrelated = JSON.parse(serializeScriptDraftSnapshot(createScriptDraftSnapshot({
    identity: 'project-1',
    document,
    mustSay: metadata,
  })));
  const unrelatedMetadata = JSON.parse(unrelated.mustSay);
  unrelatedMetadata.requirements[0].lineId = 'line-from-another-draft';
  unrelated.mustSay = JSON.stringify(unrelatedMetadata);
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(unrelated)), 'must-say-mismatch');
});

test('malformed must-say metadata is rejected instead of falling back to disabled state', () => {
  const document = parseScript('Required words.');
  const snapshot = createScriptDraftSnapshot({
    identity: 'project-1',
    document,
    mustSay: metadataFor(document),
  });
  const parsed = JSON.parse(serializeScriptDraftSnapshot(snapshot));
  parsed.mustSay = '{"version":1,"requirements":[{"lineId":"line-1","enabled":true}],"archived":[]}';
  expectCode(() => deserializeScriptDraftSnapshot(JSON.stringify(parsed)), 'must-say-mismatch');
});

test('legacy missing snapshot returns null and leaves the caller raw text untouched', () => {
  const legacyText = 'Legacy script text stays available.';
  const restored = deserializeScriptDraftSnapshot(null, { expectedIdentity: 'project-1' });
  assert.equal(restored, null);
  assert.equal(legacyText, 'Legacy script text stays available.');
  assert.equal(deserializeScriptDraftSnapshot(undefined), null);
});

test('the persisted structure remains the existing script serializer output', () => {
  const document = parseScript('First. [wave]\nSecond.');
  const snapshot = createScriptDraftSnapshot({
    identity: 'project-1',
    document,
    mustSay: metadataFor(document),
  });
  assert.deepEqual(JSON.parse(snapshot.structure), JSON.parse(serializeScriptDocument(document)));
});
