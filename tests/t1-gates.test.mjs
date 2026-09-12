import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tier1Enabled, TIER1_RELEASE_GATES } from '../src/lib/t1-gates.ts';
import { normalizeProject } from '../src/lib/project-data.ts';
test('all Tier 1 features require explicit development opt-in and cannot enable release', () => {
  for (const feature of Object.keys(TIER1_RELEASE_GATES)) {
    assert.equal(tier1Enabled(feature, false, true), false);
    assert.equal(tier1Enabled(feature, true), false);
    assert.equal(tier1Enabled(feature, true, true), true);
  }
});
test('legacy project normalization preserves original and has no Tier 1 evidence', () => {
  const project = normalizeProject({ id: 'old', mode: 'script', videoUri: 'file:///original.mp4', transcript: [] });
  assert.equal(project.videoUri, 'file:///original.mp4');
  assert.equal(project.tier1Evidence, undefined);
});
