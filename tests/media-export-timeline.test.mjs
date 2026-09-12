import assert from 'node:assert/strict';
import test from 'node:test';
import { mapExportCaptions, validateExportCuts } from '../modules/one-take-media/timeline.ts';

test('maps source captions onto ordered non-adjacent output cuts', () => {
  assert.deepEqual(
    mapExportCaptions(
      [
        { t0: 1, t1: 6, text: 'hello' },
        { t0: 8, t1: 9, text: 'again' },
      ],
      [
        { t0: 0, t1: 2 },
        { t0: 5, t1: 8.5 },
      ],
    ),
    [
      { t0: 1, t1: 2, text: 'hello' },
      { t0: 2, t1: 3, text: 'hello' },
      { t0: 5, t1: 5.5, text: 'again' },
    ],
  );
});

test('rejects overlapping source cuts but preserves explicit output order', () => {
  assert.throws(() => validateExportCuts([{ t0: 0, t1: 3 }, { t0: 2, t1: 4 }]));
  assert.deepEqual(validateExportCuts([{ t0: 3, t1: 4 }, { t0: 0, t1: 1 }]), [
    { t0: 3, t1: 4 },
    { t0: 0, t1: 1 },
  ]);
});

test('does not invent captions in removed gaps and rejects ambiguous caption overlap', () => {
  assert.deepEqual(
    mapExportCaptions([{ t0: 3, t1: 6, text: 'gap crossing' }], [{ t0: 0, t1: 4 }, { t0: 5, t1: 7 }]),
    [
      { t0: 3, t1: 4, text: 'gap crossing' },
      { t0: 4, t1: 5, text: 'gap crossing' },
    ],
  );
  assert.throws(() => mapExportCaptions([
    { t0: 0, t1: 2, text: 'one' },
    { t0: 1, t1: 3, text: 'two' },
  ], []));
});
