import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewExportSelection } from '../src/lib/review-export-selection.ts';
const p = { id: 'p', cuts: [{ t0: 4, t1: 8 }], cutsReviewed: true, transcript: [{ text: 'hi' }] };
test('automatic cuts require preparation before export', () => {
  assert.equal(reviewExportSelection({ ...p, cuts: undefined }, 'cut', true), null);
  assert.equal(reviewExportSelection(p, 'cut', true), p);
});
test('manual trim and original exports override prepared cuts without changing project', () => {
  assert.equal(reviewExportSelection(p, 'trim', true).cuts, undefined);
  const original = reviewExportSelection(p, 'original', true);
  assert.deepEqual(original.cuts, []);
  assert.deepEqual(original.transcript, []);
  assert.deepEqual(p.cuts, [{ t0: 4, t1: 8 }]);
});
