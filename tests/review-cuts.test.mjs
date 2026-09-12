import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeInterval } from '../src/lib/review-cuts.ts';

test('removing a reviewed interval preserves remaining cut order and source timestamps', () => {
  assert.deepEqual(excludeInterval([{ t0: 8, t1: 10 }, { t0: 0, t1: 6 }], { t0: 2, t1: 4 }),
    [{ t0: 8, t1: 10 }, { t0: 0, t1: 2 }, { t0: 4, t1: 6 }]);
});
