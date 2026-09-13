/**
 * Read-only integration seam for the merged Session 2 framing producer.
 *
 * The producer owns request/track validation and deterministic crop generation.
 * The review/export lane owns the stricter evidence needed before applying a
 * crop.  This bridge runs the producer as published, then sends its result
 * through the consumer adapter without deriving missing temporal or layout
 * semantics from observations.
 */

import {
  buildFramingSuggestion,
  validateFramingRequest,
  validateFramingSuggestion,
  validateFramingTracks,
  type FramingAnalysisRequest,
  type FramingBuildOptions,
  type FramingRegionTrack,
  type FramingSuggestion,
  type FramingValidation,
} from '../features/vision/framing.ts';
import {
  FRAMING_FIXTURES,
  type FramingFixture,
} from '../features/vision/framing-fixtures.ts';
import {
  adaptProviderFramingSuggestion,
  type FramingProviderAdapterResult,
} from './t1-framing-provider.ts';

export type IntegratedFramingField =
  | 'coverage'
  | 'movement'
  | 'protectedRegions'
  | 'unionProof'
  | 'captionSafeArea';

export type IntegratedFramingFieldGap = Readonly<{
  field: IntegratedFramingField;
  owner: 'producer';
  requiredFor: string;
  evidence: string;
}>;

/**
 * These are transport-level gaps in the merged producer result.  Existing
 * track observations are retained in the producer fixture result, but the
 * bridge does not reinterpret them as any of these stronger claims.
 */
export const INTEGRATED_FRAMING_FIELD_GAPS: readonly IntegratedFramingFieldGap[] = Object.freeze([
  Object.freeze({
    field: 'coverage' as const,
    owner: 'producer' as const,
    requiredFor: 'proof that relevant evidence covers the complete selected interval',
    evidence: 'The producer result has no explicit coverage state for the selected interval.',
  }),
  Object.freeze({
    field: 'movement' as const,
    owner: 'producer' as const,
    requiredFor: 'permission to apply one immutable crop for the complete cut',
    evidence: 'A stable-union crop reason does not certify subject movement between observations.',
  }),
  Object.freeze({
    field: 'protectedRegions' as const,
    owner: 'producer' as const,
    requiredFor: 'consumer checks that faces, products, and hands remain inside the crop and caption area',
    evidence: 'The producer result has supporting track IDs but no normalized protected-region union rectangles.',
  }),
  Object.freeze({
    field: 'unionProof' as const,
    owner: 'producer' as const,
    requiredFor: 'proof that the static crop covers the selected interval boundaries',
    evidence: 'Sampled track observations do not prove both half-open interval boundaries or every intervening frame.',
  }),
  Object.freeze({
    field: 'captionSafeArea' as const,
    owner: 'producer' as const,
    requiredFor: 'proof that the native lower-third caption overlay remains safe after cropping',
    evidence: 'The producer result has no caption safe-area rectangle in source coordinates.',
  }),
]);

export type IntegratedFramingResult = Readonly<{
  fixtureId?: string;
  request: FramingAnalysisRequest;
  tracks: readonly FramingRegionTrack[];
  requestValidation: FramingValidation;
  tracksValidation: FramingValidation;
  producerSuggestion: FramingSuggestion;
  producerValidation: FramingValidation;
  consumer: FramingProviderAdapterResult;
  remainingFieldGaps: readonly IntegratedFramingFieldGap[];
}>;

function freezeValidation(validation: FramingValidation): FramingValidation {
  return Object.freeze({
    valid: validation.valid,
    ...(validation.reason ? { reason: validation.reason } : {}),
    errors: Object.freeze([...validation.errors]),
  });
}
function remainingFieldGaps(suggestion: FramingSuggestion): readonly IntegratedFramingFieldGap[] {
  return Object.freeze(INTEGRATED_FRAMING_FIELD_GAPS.filter(gap => !(gap.field in suggestion)));
}

/**
 * Run the actual merged producer and bridge its result to review/export.
 * Passing `{ enabled: true }` is an explicit deterministic development path;
 * omitting options keeps the producer's default false gate intact.
 */
export function integrateProducerFraming(
  request: FramingAnalysisRequest,
  tracks: readonly FramingRegionTrack[],
  options: FramingBuildOptions = {},
): IntegratedFramingResult {
  const requestValidation = freezeValidation(validateFramingRequest(request));
  const tracksValidation = freezeValidation(validateFramingTracks(request, tracks));
  const producerSuggestion = buildFramingSuggestion(request, tracks, options);
  const producerValidation = freezeValidation(validateFramingSuggestion(producerSuggestion, request));
  const consumer = adaptProviderFramingSuggestion(producerSuggestion, request);
  return Object.freeze({
    request,
    tracks,
    requestValidation,
    tracksValidation,
    producerSuggestion,
    producerValidation,
    consumer,
    remainingFieldGaps: remainingFieldGaps(producerSuggestion),
  });
}

/** Replay one merged producer fixture through the consumer adapter. */
export function integrateFramingFixture(
  fixtureId: string,
  options: FramingBuildOptions = {},
): IntegratedFramingResult {
  const fixture: FramingFixture | undefined = FRAMING_FIXTURES.find(row => row.id === fixtureId);
  if (!fixture) throw new RangeError(`Unknown framing fixture: ${fixtureId}`);
  const result = integrateProducerFraming(fixture.request, fixture.tracks, options);
  return Object.freeze({ ...result, fixtureId });
}
