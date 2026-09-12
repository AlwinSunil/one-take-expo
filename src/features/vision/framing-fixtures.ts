import {
  buildFramingSuggestion,
  FRAMING_REASON_TEXT,
  validateFramingSuggestion,
  type FramingAnalysisRequest,
  type FramingBuildOptions,
  type FramingFrame,
  type FramingIdentity,
  type FramingIntent,
  type FramingReason,
  type FramingRect,
  type FramingRegionKind,
  type FramingRegionObservation,
  type FramingRegionTrack,
  type FramingSuggestion,
  type FramingValidation,
} from './framing.ts';

/**
 * Development-only provider metadata. These rules execute on the host CPU;
 * they do not exercise a phone detector or establish NPU behavior.
 */
export const FRAMING_FIXTURE_POLICY = Object.freeze({
  source: 'fixture' as const,
  developmental: true as const,
  enabledByDefault: false as const,
  execution: 'host-cpu' as const,
  actualProcessor: 'cpu' as const,
  inferenceHardware: 'none' as const,
});

export const FRAMING_FIXTURE_PROVENANCE = Object.freeze({
  source: 'fixture' as const,
  model: 'deterministic-framing-rules',
  modelVersion: '1',
  processor: 'cpu' as const,
  runtime: 'node-host-fixture',
});

export type FramingFixture = Readonly<{
  id: string;
  description: string;
  request: FramingAnalysisRequest;
  tracks: readonly FramingRegionTrack[];
  expected: Readonly<{
    originalFrameFallback: boolean;
    reason: FramingReason;
  }>;
}>;

export type FramingFixtureReplay = Readonly<{
  fixtureId: string;
  description: string;
  expected: FramingFixture['expected'];
  actual: Readonly<{
    originalFrameFallback: boolean;
    reason: FramingReason;
    reasons: readonly FramingReason[];
    crop: FramingRect;
    confidence: number;
    supportingTrackIds: readonly string[];
    reasonText: string;
  }>;
  provenance: FramingSuggestion['provenance'];
  policy: typeof FRAMING_FIXTURE_POLICY;
  validation: FramingValidation;
  passed: boolean;
}>;

function identity(id: string): FramingIdentity {
  return {
    sourceMediaId: `fixture-media-${id}`,
    takeId: `fixture-take-${id}`,
    analysisId: `fixture-analysis-${id}`,
    analysisRevision: 1,
  };
}

function frame(width: number, height: number, rotationDegrees: 0 | 90 | 180 | 270 = 0): FramingFrame {
  return {
    coordinateSpace: 'normalized-upright-unmirrored',
    orientation: height >= width ? 'portrait' : 'landscape',
    rotationDegrees,
    uprightWidthPx: width,
    uprightHeightPx: height,
    aspectRatio: width / height,
  };
}

function request(
  id: string,
  intent: FramingIntent,
  sourceDurationMs: number,
  selectedInterval: { startMs: number; endMs: number },
  sourceFrame: FramingFrame,
): FramingAnalysisRequest {
  return {
    ...identity(id),
    sourceDurationMs,
    selectedInterval,
    intent,
    frame: sourceFrame,
    provenance: { ...FRAMING_FIXTURE_PROVENANCE, fixtureId: id },
  };
}

function observations(
  timestamps: readonly number[],
  rects: readonly FramingRect[],
  confidence: number | readonly number[] = 0.93,
): readonly FramingRegionObservation[] {
  if (timestamps.length !== rects.length) throw new Error('fixture timestamps and rectangles must align');
  return timestamps.map((timestampMs, index) => ({
    timestampMs,
    rect: rects[index],
    confidence: typeof confidence === 'number' ? confidence : confidence[index],
  }));
}

function track(
  sourceIdentity: FramingIdentity,
  trackId: string,
  kind: FramingRegionKind,
  selected: boolean,
  relevant: boolean,
  timestamps: readonly number[],
  rects: readonly FramingRect[],
  confidence?: number | readonly number[],
): FramingRegionTrack {
  return {
    identity: { ...sourceIdentity },
    trackId,
    kind,
    selected,
    relevant,
    observations: observations(timestamps, rects, confidence),
  };
}

function repeated(
  sourceIdentity: FramingIdentity,
  trackId: string,
  kind: FramingRegionKind,
  selected: boolean,
  relevant: boolean,
  timestamps: readonly number[],
  rect: FramingRect,
  confidence = 0.93,
): FramingRegionTrack {
  return track(sourceIdentity, trackId, kind, selected, relevant, timestamps, timestamps.map(() => rect), confidence);
}

const portraitTimes = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500] as const;
const shortTimes = [0, 500, 1000, 1500, 2000, 2500] as const;

const portraitTalkingHeadIdentity = identity('portrait-talking-head');
const portraitTalkingHeadRequest = request(
  'portrait-talking-head',
  'talking-head',
  5000,
  { startMs: 1000, endMs: 5000 },
  frame(1080, 1920),
);

const portraitTalkingHead: FramingFixture = {
  id: 'portrait-talking-head',
  description: 'A single face moves gently across an upright portrait take.',
  request: portraitTalkingHeadRequest,
  tracks: [track(
    portraitTalkingHeadIdentity,
    'face-anna',
    'face',
    true,
    true,
    portraitTimes,
    [
      { x: 0.29, y: 0.18, width: 0.18, height: 0.17 },
      { x: 0.31, y: 0.19, width: 0.18, height: 0.17 },
      { x: 0.33, y: 0.21, width: 0.18, height: 0.17 },
      { x: 0.35, y: 0.22, width: 0.18, height: 0.17 },
      { x: 0.37, y: 0.23, width: 0.18, height: 0.17 },
      { x: 0.39, y: 0.24, width: 0.18, height: 0.17 },
      { x: 0.40, y: 0.24, width: 0.18, height: 0.17 },
      { x: 0.42, y: 0.25, width: 0.18, height: 0.17 },
    ],
  )],
  expected: { originalFrameFallback: false, reason: 'talking-head-subject' },
};

const movingVlogIdentity = identity('moving-vlog-subject');
const movingVlog: FramingFixture = {
  id: 'moving-vlog-subject',
  description: 'A selected subject travels across the interval and needs one temporal union crop.',
  request: request('moving-vlog-subject', 'vlog', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [track(
    movingVlogIdentity,
    'subject-moving',
    'subject',
    true,
    true,
    shortTimes,
    [
      { x: 0.04, y: 0.34, width: 0.15, height: 0.22 },
      { x: 0.16, y: 0.35, width: 0.15, height: 0.22 },
      { x: 0.28, y: 0.35, width: 0.15, height: 0.22 },
      { x: 0.40, y: 0.36, width: 0.15, height: 0.22 },
      { x: 0.52, y: 0.36, width: 0.15, height: 0.22 },
      { x: 0.64, y: 0.36, width: 0.15, height: 0.22 },
    ],
  )],
  expected: { originalFrameFallback: false, reason: 'vlog-subject' },
};

const productHandsIdentity = identity('product-demo-with-hands');
const productHandsTimes = shortTimes;
const productHands: FramingFixture = {
  id: 'product-demo-with-hands',
  description: 'A selected product and two relevant hands remain in one static crop.',
  request: request('product-demo-with-hands', 'product-demo', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [
    repeated(productHandsIdentity, 'product-phone', 'product', true, true, productHandsTimes,
      { x: 0.40, y: 0.35, width: 0.20, height: 0.24 }),
    repeated(productHandsIdentity, 'hand-left', 'hand', false, true, productHandsTimes,
      { x: 0.25, y: 0.43, width: 0.12, height: 0.18 }),
    repeated(productHandsIdentity, 'hand-right', 'hand', false, true, productHandsTimes,
      { x: 0.63, y: 0.42, width: 0.12, height: 0.19 }),
  ],
  expected: { originalFrameFallback: false, reason: 'product-and-hands' },
};

const multiplePeopleIdentity = identity('multiple-people-safe');
const multiplePeopleSafe: FramingFixture = {
  id: 'multiple-people-safe',
  description: 'Two selected faces fit within one conservative union crop.',
  request: request('multiple-people-safe', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [
    repeated(multiplePeopleIdentity, 'face-left', 'face', true, true, shortTimes,
      { x: 0.18, y: 0.27, width: 0.16, height: 0.19 }),
    repeated(multiplePeopleIdentity, 'face-right', 'face', true, true, shortTimes,
      { x: 0.56, y: 0.29, width: 0.16, height: 0.19 }),
  ],
  expected: { originalFrameFallback: false, reason: 'talking-head-subject' },
};

const unsafePeopleIdentity = identity('multiple-people-unsafe');
const multiplePeopleUnsafe: FramingFixture = {
  id: 'multiple-people-unsafe',
  description: 'Two faces at opposite edges exceed the safe zoom and margin envelope.',
  request: request('multiple-people-unsafe', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [
    repeated(unsafePeopleIdentity, 'face-edge-left', 'face', true, true, shortTimes,
      { x: 0.01, y: 0.30, width: 0.16, height: 0.19 }),
    repeated(unsafePeopleIdentity, 'face-edge-right', 'face', true, true, shortTimes,
      { x: 0.83, y: 0.30, width: 0.16, height: 0.19 }),
  ],
  expected: { originalFrameFallback: true, reason: 'unsafe-multiple-subjects' },
};

const missingIdentity = identity('missing-detections');
const missingDetections: FramingFixture = {
  id: 'missing-detections',
  description: 'The provider has no regions for the selected interval.',
  request: request('missing-detections', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [],
  expected: { originalFrameFallback: true, reason: 'missing-detection' },
};

const offFrameIdentity = identity('off-frame-detection');
const offFrameDetection: FramingFixture = {
  id: 'off-frame-detection',
  description: 'A malformed selected box crosses the right edge of the source.',
  request: request('off-frame-detection', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [repeated(offFrameIdentity, 'face-off-frame', 'face', true, true, shortTimes,
    { x: 0.92, y: 0.30, width: 0.15, height: 0.18 })],
  expected: { originalFrameFallback: true, reason: 'off-frame' },
};

const lowConfidenceIdentity = identity('low-confidence');
const lowConfidence: FramingFixture = {
  id: 'low-confidence',
  description: 'A selected track is present but below the conservative confidence floor.',
  request: request('low-confidence', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [repeated(lowConfidenceIdentity, 'face-uncertain', 'face', true, true, shortTimes,
    { x: 0.38, y: 0.26, width: 0.18, height: 0.20 }, 0.42)],
  expected: { originalFrameFallback: true, reason: 'low-confidence' },
};

const discontinuousIdentity = identity('discontinuous-track');
const discontinuous: FramingFixture = {
  id: 'discontinuous-track',
  description: 'A selected track disappears for longer than the safe temporal gap.',
  request: request('discontinuous-track', 'vlog', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [track(discontinuousIdentity, 'subject-gap', 'subject', true, true,
    [0, 1000, 2500], [
      { x: 0.30, y: 0.34, width: 0.18, height: 0.22 },
      { x: 0.34, y: 0.34, width: 0.18, height: 0.22 },
      { x: 0.38, y: 0.34, width: 0.18, height: 0.22 },
    ]),
  ],
  expected: { originalFrameFallback: true, reason: 'discontinuous-track' },
};

const missingHandsIdentity = identity('product-demo-missing-hands');
const productWithoutHands: FramingFixture = {
  id: 'product-demo-missing-hands',
  description: 'A selected product without relevant hands cannot receive a presenter-only crop.',
  request: request('product-demo-missing-hands', 'product-demo', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [repeated(missingHandsIdentity, 'product-alone', 'product', true, true, shortTimes,
    { x: 0.42, y: 0.34, width: 0.18, height: 0.23 })],
  expected: { originalFrameFallback: true, reason: 'hands-missing' },
};

const productOnlyIntentIdentity = identity('product-only-talk-intent');
const productOnlyTalkIntent: FramingFixture = {
  id: 'product-only-talk-intent',
  description: 'Product and hands in a talking-head intent have no face-centric subject target.',
  request: request('product-only-talk-intent', 'talking-head', 3000, { startMs: 0, endMs: 3000 }, frame(1920, 1080)),
  tracks: [
    repeated(productOnlyIntentIdentity, 'product-only', 'product', true, true, shortTimes,
      { x: 0.42, y: 0.34, width: 0.18, height: 0.23 }),
    repeated(productOnlyIntentIdentity, 'hands-only', 'hand', false, true, shortTimes,
      { x: 0.30, y: 0.43, width: 0.12, height: 0.18 }),
  ],
  expected: { originalFrameFallback: true, reason: 'no-relevant-subject' },
};

export const FRAMING_FIXTURES: readonly FramingFixture[] = Object.freeze([
  portraitTalkingHead,
  movingVlog,
  productHands,
  multiplePeopleSafe,
  multiplePeopleUnsafe,
  missingDetections,
  offFrameDetection,
  lowConfidence,
  discontinuous,
  productWithoutHands,
  productOnlyTalkIntent,
]);

/**
 * Replays the fixture catalog into JSON-friendly rows. The replay is opt-in:
 * omitting options keeps the production default disabled, while callers that
 * explicitly request developmental fixtures pass `{ enabled: true }`.
 */
export function replayFramingFixtures(options: FramingBuildOptions = {}): readonly FramingFixtureReplay[] {
  return FRAMING_FIXTURES.map(fixture => {
    const suggestion = buildFramingSuggestion(fixture.request, fixture.tracks, options);
    const validation = validateFramingSuggestion(suggestion, fixture.request);
    const actual = {
      originalFrameFallback: suggestion.originalFrameFallback,
      reason: suggestion.reason,
      reasons: [...suggestion.reasons],
      crop: { ...suggestion.crop },
      confidence: suggestion.confidence,
      supportingTrackIds: [...suggestion.supportingTrackIds],
      reasonText: FRAMING_REASON_TEXT[suggestion.reason],
    };
    return {
      fixtureId: fixture.id,
      description: fixture.description,
      expected: fixture.expected,
      actual,
      provenance: suggestion.provenance,
      policy: FRAMING_FIXTURE_POLICY,
      validation,
      passed: validation.valid
        && actual.originalFrameFallback === fixture.expected.originalFrameFallback
        && actual.reason === fixture.expected.reason,
    };
  });
}

/** Explicit fixture mode for a development report or deterministic benchmark. */
export function replayDevelopmentFramingFixtures(): readonly FramingFixtureReplay[] {
  return replayFramingFixtures({ enabled: true });
}
