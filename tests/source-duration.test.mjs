import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDuration, sourceRangeFits } from '../src/lib/source-duration.ts';

test('regression: the reported phone clip ends within file metadata but beyond the decoder duration', () => {
  const savedFromPlayer = 18.187000274658203;
  const measuredFromFile = 18.188;
  const cuts = [{ t0: 0, t1: 5.886000011444092 }, { t0: 8.52, t1: 11.774000022888183 }, { t0: 13.616, t1: 18.188 }];
  assert.equal(sourceRangeFits(cuts[2], savedFromPlayer), false);
  assert.ok(cuts.every(cut => sourceRangeFits(cut, sourceDuration(measuredFromFile, savedFromPlayer, savedFromPlayer))));
});
test('saved metadata keeps valid cuts playable while the player has not loaded', () => {
  assert.equal(sourceDuration(undefined, 18.188, 0), 18.188);
});
test('fresh measurements override stale saved values and still reject real out-of-bounds cuts', () => {
  assert.equal(sourceRangeFits({ t0: 0, t1: 19 }, sourceDuration(18.188, 30, 30)), false);
  assert.equal(sourceRangeFits({ t0: 0, t1: 18.2 }, sourceDuration(18.188, 18.187, 18.187)), false);
  assert.equal(sourceRangeFits({ t0: -1, t1: 3 }, 18.188), false);
  assert.equal(sourceRangeFits({ t0: 3, t1: 3 }, 18.188), false);
});
test('invalid metadata never becomes an infinite or negative source bound', () => {
  assert.equal(sourceDuration(NaN, Infinity, 0), 0);
  assert.equal(sourceDuration(-1, 0, 4), 4);
  assert.equal(sourceRangeFits({ t0: 0, t1: 1 }, Infinity), false);
});
