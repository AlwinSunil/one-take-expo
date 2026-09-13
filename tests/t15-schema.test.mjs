import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  canonicalJson,
  createFoundation,
  framingIntervalFromMs,
  sameRevisions,
  validateFoundation,
} from '../src/lib/t15-schema.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/t15-foundation.json', import.meta.url), 'utf8'));

function legacyProject(overrides = {}) {
  return {
    ...fixture.project,
    transcript: fixture.project.transcript.map(segment => ({ ...segment })),
    recordings: fixture.project.recordings.map(recording => ({ ...recording })),
    takes: fixture.project.takes.map(take => ({ ...take })),
    ...overrides,
  };
}

test('legacy migration creates stable root and pickup sources while keeping the recording alias', () => {
  const state = createFoundation(legacyProject());
  assert.equal(state.version, 1);
  assert.equal(state.projectId, fixture.expected.projectId);
  assert.equal(state.sources[0].id, fixture.expected.rootSourceId);
  assert.deepEqual(state.sources[0].aliases, [fixture.expected.originalAlias]);
  assert.equal(state.sources.some(source => source.id === fixture.expected.originalAlias), false);
  assert.equal(state.sources.find(source => source.id === fixture.expected.pickupSourceId)?.mediaUri, 'file:///fixture-pickup.mp4');
  assert.deepEqual(legacyProject().trim, undefined);
  validateFoundation(state, legacyProject());
});

test('migration preserves immutable legacy transcript, takes and unknown defaults', () => {
  const project = legacyProject({
    trim: { start: 0.25, end: 3.75 },
    transcript: [{ ...fixture.project.transcript[0], manualCorrection: '' }],
    duration: undefined,
    mediaMissing: true,
  });
  const state = createFoundation(project);
  assert.deepEqual(project.trim, { start: 0.25, end: 3.75 });
  assert.deepEqual(state.transcriptRevisions.flatMap(revision => revision.segments ?? []).map(segment => segment.text), project.transcript.map(segment => segment.text));
  assert.equal(state.takes.length, project.takes.length);
  assert.equal(state.sources.find(source => source.id === project.id)?.durationSeconds, null);
  assert.equal(state.sources.find(source => source.id === project.id)?.availability, 'missing');
  assert.equal(state.transcriptRevisions[0].status, 'complete');
  assert.equal(state.captionCorrections[0].text, '');
  validateFoundation(state, project);
});

test('source-relative framing adapter converts milliseconds once and retains uncertainty provenance', () => {
  const interval = framingIntervalFromMs({
    sourceMediaId: 'source:pickup',
    startMs: 1250,
    endMs: 3750,
    uncertaintyMs: 40,
    provenance: { origin: 'fixture-framing', producer: 'session-2', version: '1', timingMethod: 'capture-clock' },
  });
  assert.equal(interval.sourceId, 'source:pickup');
  assert.deepEqual([interval.t0, interval.t1], [1.25, 3.75]);
  assert.equal(interval.provenance.inputUnit, 'milliseconds');
  assert.equal(interval.provenance.uncertaintySeconds, 0.04);
  assert.equal(interval.provenance.processor, 'unknown');
  assert.throws(() => framingIntervalFromMs({ sourceId: 'source:pickup', startMs: 1250, endMs: 3750, sourceDurationMs: 3000 }), /duration/);
  assert.throws(() => framingIntervalFromMs({ sourceId: 'source:pickup', startMs: 1000, endMs: 1000 }), /non-empty/);
});

test('canonical payload equality ignores object insertion order but preserves array order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: true, c: 1 } }), canonicalJson({ a: { c: 1, d: true }, b: 2 }));
  assert.notEqual(canonicalJson({ values: ['a', 'b'] }), canonicalJson({ values: ['b', 'a'] }));
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /non-finite/);
  assert.equal(canonicalJson({ invalid: undefined }), '{}');
});

test('revision equality includes source transcript revisions and rejects malformed vectors', () => {
  const left = { projectRevision: 1, scriptRevision: 2, timelineRevision: 3, captionRevision: 4, transcriptRevision: { root: 5, pickup: 1 } };
  const right = { projectRevision: 1, scriptRevision: 2, timelineRevision: 3, captionRevision: 4, transcriptRevision: { pickup: 1, root: 5 } };
  assert.equal(sameRevisions(left, right), true);
  assert.equal(sameRevisions(left, { ...right, transcriptRevision: { pickup: 2, root: 5 } }), false);
  assert.equal(sameRevisions(left, { ...right, projectRevision: -1 }), false);
});

test('timeline keeps source-local intervals and excluded rows without source deletion', () => {
  const state = createFoundation(legacyProject());
  state.timeline = {
    revision: 1,
    clips: fixture.timeline.clips.map((clip, index) => ({ ...clip, included: index !== 1 })),
  };
  state.revisions = { ...state.revisions, timelineRevision: 1, projectRevision: 1 };
  state.history.entries.push({
    id: 'history:exclude-b',
    operationId: 'operation:exclude-b',
    kind: 'exclude',
    baseRevision: 0,
    revision: 1,
    before: fixture.timeline.clips,
    after: state.timeline.clips,
    reasonIds: [],
  });
  state.history.cursor = 1;
  validateFoundation(state, legacyProject());
  assert.equal(state.sources.some(source => source.id === 'source:pickup'), true);
  assert.equal(state.timeline.clips[1].included, false);
});

test('paged transcript and observation evidence validate without loading a giant payload', () => {
  const state = createFoundation(legacyProject());
  state.transcriptRevisions[0] = {
    ...state.transcriptRevisions[0],
    status: 'complete',
    segments: undefined,
    chunks: [{ id: 'chunk:transcript:0', ordinal: 0, total: 2 }, { id: 'chunk:transcript:1', ordinal: 1, total: 2 }],
  };
  state.observations.push({
    id: 'observation:fixture:1',
    sourceId: state.projectId,
    t0: null,
    t1: null,
    kind: 'gaze',
    status: 'unknown',
    provenance: {
      origin: 'fixture', producer: 'session-2', version: '1', clock: 'unknown', timingMethod: 'not-collected', inputUnit: 'unknown', uncertaintySeconds: null, processor: 'unknown',
    },
    chunks: [{ id: 'chunk:observation:0', ordinal: 0, total: 1 }],
  });
  validateFoundation(state, legacyProject());
});

test('invalid states fail closed without changing legacy project data', () => {
  const project = legacyProject();
  const state = createFoundation(project);
  const legacyBefore = JSON.stringify({ trim: project.trim, transcript: project.transcript, takes: project.takes });
  state.timeline.clips[0].sourceId = 'different-source';
  assert.throws(() => validateFoundation(state, project), /unknown source/);
  assert.equal(JSON.stringify({ trim: project.trim, transcript: project.transcript, takes: project.takes }), legacyBefore);

  const future = createFoundation(project);
  future.version = 2;
  assert.throws(() => validateFoundation(future, project), /unsupported/);
});

test('reopen does not regenerate stable identities from mutable text', () => {
  const project = legacyProject();
  const first = createFoundation(project);
  const reopened = createFoundation({ ...project, v15: first, script: 'A changed wording. B. C.' });
  assert.deepEqual(reopened, first);
  assert.equal(reopened.scriptSnapshots[0].spans[0].id, first.scriptSnapshots[0].spans[0].id);
});


test('instantaneous gaze and uncertain capture-clock observations remain evidence, never clip ranges', () => {
  const project = { id: 'gaze', mode: 'assisted', duration: 1, videoUri: 'file:///original.mp4', transcript: [], clips: [], createdAt: 1 };
  const state = createFoundation(project);
  state.observations = [{ id: 'sample', sourceId: 'gaze', t0: 1.2, t1: 1.2, kind: 'gaze', status: 'unknown', provenance: { ...state.sources[0].timing, clock: 'capture-clock', uncertaintySeconds: null }, payload: { label: 'unknown' } }];
  validateFoundation(state, project);
  state.observations[0].provenance.clock = 'source-presentation';
  assert.throws(() => validateFoundation(state, project), /sample time/);
});

test('extensions retain older versions beside a new version without interpreting payloads', () => {
  const project = { id: 'extensions', mode: 'assisted', duration: 1, videoUri: null, transcript: [], clips: [], createdAt: 1 };
  const state = createFoundation(project);
  state.extensions = [1, 2].map(version => ({ key: 'future:visual', version, availability: 'unsupported', assetIds: [], payload: { originalVersion: version } }));
  validateFoundation(state, project);
  state.extensions.push({ ...state.extensions[0] });
  assert.throws(() => validateFoundation(state, project), /duplicated/);
});
