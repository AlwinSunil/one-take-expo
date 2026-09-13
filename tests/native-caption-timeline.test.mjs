import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCaptionTimeline } from '../src/lib/caption-timeline.ts';
import { buildExportPlan } from '../src/lib/export-plan.ts';
import { validateExportCaptions } from '../modules/one-take-media/timeline.ts';

const captions = [
  { id: 'happy', t0: 2.2340000095, t1: 3.1940000477, text: "I'm happy.", isFinal: true },
  { id: 'filler', t0: 3.0339999619, t1: 4.3779998245, text: 'Um...', isFinal: true },
];
test('overlapping pickup recognition yields the same valid captions in preview and export', () => {
  const preview = nativeCaptionTimeline(captions);
  assert.doesNotThrow(() => validateExportCaptions(preview));
  assert.deepEqual(preview.map(c => c.text), ["I'm happy.", "I'm happy.\nUm...", 'Um...']);
  const project = { id: 'p', videoUri: 'file:///primary.mp4', createdAt: 0, clips: [], cutsReviewed: true,
    transcript: captions.map(c => ({ ...c, recordingId: 'pickup' })),
    recordings: [{ id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 8, createdAt: 1 }],
    reviewSegments: [{ uri: 'file:///pickup.mp4', t0: 2.234, t1: 4.378 }],
  };
  assert.deepEqual(buildExportPlan(project, 0, 8).segments[0].captions, preview);
});
test('float-noise boundaries do not generate sub-millisecond native captions', () => {
  const preview = nativeCaptionTimeline([
    { t0: 0, t1: 1.0000001, text: 'First' },
    { t0: 1, t1: 2, text: 'Next' },
  ]);
  assert.deepEqual(preview, [{ t0: 0, t1: 1, text: 'First' }, { t0: 1, t1: 2, text: 'Next' }]);
  assert.doesNotThrow(() => validateExportCaptions(preview));
});
test('every retained cue survives native microsecond then millisecond truncation', () => {
  const nativeMillis = seconds => Math.trunc(Math.trunc(seconds * 1_000_000) / 1000);
  const input = Array.from({ length: 100 }, (_, index) => ({ t0: (1000 + index) / 1000, t1: (1001 + index) / 1000, text: String(index) }));
  assert.ok(nativeCaptionTimeline(input).every(cue => nativeMillis(cue.t1) > nativeMillis(cue.t0)));
});
