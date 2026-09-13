/**
 * Adapter between the published Session 2 framing suggestion and the
 * review/export framing seam.
 *
 * Session 2 deliberately publishes optional crop metadata.  The review lane
 * needs a little more evidence before it can offer a reversible crop: an
 * explicit completeness and movement state, protected region geometry, a
 * temporal union proof, and a caption safe area.  This module only validates
 * and maps those fields.  It does not run recognition, infer movement, or
 * turn timestamps into media boundaries.
 */

import {
  FRAMING_SCHEMA_VERSION,
  ORIGINAL_FRAMING_CROP,
  validateFramingSuggestion,
  type FramingCrop,
  type FramingIntent,
  type FramingProvenance,
  type FramingRegion,
  type FramingRegionKind,
  type FramingSuggestion,
} from './t1-framing.ts';

export const PROVIDER_FRAMING_OWNER_ADDITIONS = Object.freeze([
  'explicit coverage state for the selected interval',
  'explicit movement state for the selected interval',
  'stable-union proof covering both selected-interval boundaries',
  'protected region rectangles with stable IDs, kinds, confidence, and relevance',
  'caption safe area in normalized upright source coordinates',
] as const);

export type ProviderFramingRotation = 0 | 90 | 180 | 270;
export type ProviderFramingOrientation = 'portrait' | 'landscape';
export type ProviderFramingProcessor = 'cpu' | 'gpu' | 'npu' | 'unknown';
export type ProviderFramingSource = 'fixture' | 'device';

export type ProviderFramingRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ProviderFramingFrame = Readonly<{
  coordinateSpace: 'normalized-upright-unmirrored';
  orientation: ProviderFramingOrientation;
  rotationDegrees: ProviderFramingRotation;
  uprightWidthPx: number;
  uprightHeightPx: number;
  aspectRatio: number;
}>;

export type ProviderFramingInterval = Readonly<{
  startMs: number;
  endMs: number;
}>;

export type ProviderFramingProvenance = Readonly<{
  source: ProviderFramingSource;
  model: string;
  modelVersion: string;
  processor: ProviderFramingProcessor;
  runtime?: string;
  fixtureId?: string;
}>;

/** The request identity accepted from a producer without importing its implementation. */
export type ProviderFramingRequest = Readonly<{
  sourceMediaId: string;
  takeId: string;
  analysisId: string;
  analysisRevision: number;
  sourceDurationMs: number;
  selectedInterval: ProviderFramingInterval;
  intent: FramingIntent;
  frame: ProviderFramingFrame;
  provenance: ProviderFramingProvenance;
}>;

/** Structural view of the currently published Session 2 result. */
export type PublishedProviderFramingSuggestion = Readonly<{
  contractVersion: 1;
  sourceMediaId: string;
  takeId: string;
  analysisId: string;
  analysisRevision: number;
  sourceDurationMs: number;
  selectedInterval: ProviderFramingInterval;
  intent: FramingIntent;
  frame: ProviderFramingFrame;
  crop?: ProviderFramingRect;
  confidence?: number;
  reason?: string;
  reasons?: readonly string[];
  reasonText?: string;
  supportingTrackIds?: readonly string[];
  originalFrameFallback: boolean;
  provenance: ProviderFramingProvenance;
  /** Additive proof fields requested by the review/export consumer. */
  coverage?: 'complete' | 'partial' | 'missing' | 'unknown';
  movement?: 'stable' | 'moving' | 'unknown';
  protectedRegions?: readonly ProviderFramingProtectedRegion[];
  unionProof?: ProviderFramingUnionProof;
  captionSafeArea?: ProviderFramingRect;
}>;

export type ProviderFramingProtectedRegion = Readonly<{
  trackId: string;
  kind: FramingRegionKind;
  rect: ProviderFramingRect;
  confidence: number;
  relevant: boolean;
}>;

export type ProviderFramingUnionProof = Readonly<{
  kind: 'stable-union';
  interval: ProviderFramingInterval;
  trackIds: readonly string[];
  startBoundaryCovered: boolean;
  endBoundaryCovered: boolean;
}>;

export type AdaptedFramingSuggestion = FramingSuggestion & Readonly<{
  /** Adapter-level disposition for review surfaces. */
  mode: 'original' | 'reframed';
  /** Convenience boundaries for review rows; they remain source-local seconds. */
  startSec: number;
  endSec: number;
  /** The producer revision is retained for persistence and stale-result checks. */
  analysisRevision: number;
  producerSource: ProviderFramingSource;
  producerModelVersion: string;
  producerRuntime?: string;
  /** Present on a conservative adapter fallback for direct review reporting. */
  fallbackReason?: 'missing-suggestion';
}>;

export type FramingProviderErrorCode =
  | 'invalid-request'
  | 'invalid-provider'
  | 'identity-mismatch'
  | 'provider-fallback'
  | 'missing-proof'
  | 'missing-caption-safe-area'
  | 'missing-coverage'
  | 'unsafe-movement'
  | 'unsafe-crop';

export type FramingProviderError = Readonly<{
  code: FramingProviderErrorCode;
  message: string;
  requestedOwnerAdditions: readonly string[];
}>;

export type FramingProviderAdapterResult =
  | Readonly<{
    ok: true;
    suggestion: AdaptedFramingSuggestion;
    error?: undefined;
  }>
  | Readonly<{
    ok: false;
    suggestion?: AdaptedFramingSuggestion;
    error: FramingProviderError;
  }>;

type UnknownRecord = Record<string, unknown>;
type ValidatedRequest = ProviderFramingRequest;

const EPSILON = 1e-6;
const VALID_ROTATIONS: readonly number[] = [0, 90, 180, 270];
const VALID_INTENTS: readonly FramingIntent[] = ['talking-head', 'vlog', 'product-demo'];
const VALID_KINDS: readonly FramingRegionKind[] = ['face', 'subject', 'product', 'hand'];
const VALID_PROCESSORS: readonly ProviderFramingProcessor[] = ['cpu', 'gpu', 'npu', 'unknown'];
const VALID_SOURCES: readonly ProviderFramingSource[] = ['fixture', 'device'];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number' && Object.is(left, right);
}

function isValidRect(value: unknown): value is ProviderFramingRect {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && value.x >= 0
    && value.y >= 0
    && value.width > 0
    && value.height > 0
    && value.x + value.width <= 1 + EPSILON
    && value.y + value.height <= 1 + EPSILON;
}

function sameInterval(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && sameNumber(left.startMs, right.startMs)
    && sameNumber(left.endMs, right.endMs);
}

function isValidInterval(value: unknown, durationMs: unknown): value is ProviderFramingInterval {
  return isRecord(value)
    && isFiniteNumber(value.startMs)
    && isFiniteNumber(value.endMs)
    && isFiniteNumber(durationMs)
    && durationMs > 0
    && value.startMs >= 0
    && value.endMs > value.startMs
    && value.endMs <= durationMs;
}

function isValidFrame(value: unknown): value is ProviderFramingFrame {
  if (!isRecord(value)
    || value.coordinateSpace !== 'normalized-upright-unmirrored'
    || (value.orientation !== 'portrait' && value.orientation !== 'landscape')
    || !VALID_ROTATIONS.includes(value.rotationDegrees as number)
    || !isInteger(value.uprightWidthPx)
    || !isInteger(value.uprightHeightPx)
    || value.uprightWidthPx <= 0
    || value.uprightHeightPx <= 0
    || !isFiniteNumber(value.aspectRatio)
    || value.aspectRatio <= 0) {
    return false;
  }
  return Math.abs(value.aspectRatio - value.uprightWidthPx / value.uprightHeightPx) <= EPSILON;
}

function sameFrame(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.coordinateSpace === right.coordinateSpace
    && left.orientation === right.orientation
    && sameNumber(left.rotationDegrees, right.rotationDegrees)
    && sameNumber(left.uprightWidthPx, right.uprightWidthPx)
    && sameNumber(left.uprightHeightPx, right.uprightHeightPx)
    && sameNumber(left.aspectRatio, right.aspectRatio);
}

function isValidProvenance(value: unknown): value is ProviderFramingProvenance {
  return isRecord(value)
    && VALID_SOURCES.includes(value.source as ProviderFramingSource)
    && isNonEmptyString(value.model)
    && isNonEmptyString(value.modelVersion)
    && VALID_PROCESSORS.includes(value.processor as ProviderFramingProcessor)
    && (value.runtime === undefined || isNonEmptyString(value.runtime))
    && (value.fixtureId === undefined || isNonEmptyString(value.fixtureId));
}

function sameOptionalString(left: unknown, right: unknown): boolean {
  return left === undefined && right === undefined
    || typeof left === 'string' && typeof right === 'string' && left === right;
}

function sameProvenance(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.source === right.source
    && left.model === right.model
    && left.modelVersion === right.modelVersion
    && left.processor === right.processor
    && sameOptionalString(left.runtime, right.runtime)
    && sameOptionalString(left.fixtureId, right.fixtureId);
}

function validateRequest(value: unknown): ValidatedRequest | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.sourceMediaId)
    || !isNonEmptyString(value.takeId)
    || !isNonEmptyString(value.analysisId)
    || !isInteger(value.analysisRevision)
    || value.analysisRevision < 0
    || !isFiniteNumber(value.sourceDurationMs)
    || value.sourceDurationMs <= 0
    || !isValidInterval(value.selectedInterval, value.sourceDurationMs)
    || !VALID_INTENTS.includes(value.intent as FramingIntent)
    || !isValidFrame(value.frame)
    || !isValidProvenance(value.provenance)) {
    return undefined;
  }
  return value as unknown as ValidatedRequest;
}

function providerIdentityMatches(provider: UnknownRecord, request: ValidatedRequest): boolean {
  return provider.sourceMediaId === request.sourceMediaId
    && provider.takeId === request.takeId
    && provider.analysisId === request.analysisId
    && sameNumber(provider.analysisRevision, request.analysisRevision)
    && sameNumber(provider.sourceDurationMs, request.sourceDurationMs)
    && sameInterval(provider.selectedInterval, request.selectedInterval)
    && provider.intent === request.intent
    && sameFrame(provider.frame, request.frame)
    && sameProvenance(provider.provenance, request.provenance);
}

function sourceProvenance(request: ValidatedRequest): FramingProvenance {
  return Object.freeze({
    provider: request.provenance.source,
    model: request.provenance.model,
    processor: request.provenance.processor,
  });
}

function freezeRect(rect: ProviderFramingRect): FramingCrop {
  return Object.freeze({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

function freezeRegion(region: ProviderFramingProtectedRegion): FramingRegion {
  return Object.freeze({
    trackId: region.trackId,
    kind: region.kind,
    rect: freezeRect(region.rect),
    confidence: region.confidence,
    relevant: region.relevant,
  });
}

function fallbackSuggestion(
  request: ValidatedRequest,
  reason: string,
): AdaptedFramingSuggestion {
  return Object.freeze({
    version: FRAMING_SCHEMA_VERSION,
    mode: 'original' as const,
    sourceMediaId: request.sourceMediaId,
    takeId: request.takeId,
    analysisId: request.analysisId,
    analysisRevision: request.analysisRevision,
    sourceDurationSec: request.sourceDurationMs / 1000,
    startSec: request.selectedInterval.startMs / 1000,
    endSec: request.selectedInterval.endMs / 1000,
    interval: Object.freeze({
      startSec: request.selectedInterval.startMs / 1000,
      endSec: request.selectedInterval.endMs / 1000,
    }),
    intent: request.intent,
    frame: Object.freeze({
      uprightWidthPx: request.frame.uprightWidthPx,
      uprightHeightPx: request.frame.uprightHeightPx,
      rotationDegrees: request.frame.rotationDegrees,
    }),
    coverage: 'unknown',
    movement: 'unknown',
    protectedKinds: Object.freeze([]),
    regions: Object.freeze([]),
    crop: ORIGINAL_FRAMING_CROP,
    confidence: 0,
    status: 'uncertain',
    provenance: sourceProvenance(request),
    reason,
    producerSource: request.provenance.source,
    producerModelVersion: request.provenance.modelVersion,
    ...(request.provenance.runtime ? { producerRuntime: request.provenance.runtime } : {}),
    fallbackReason: 'missing-suggestion',
  });
}

function failure(
  request: ValidatedRequest,
  code: FramingProviderErrorCode,
  message: string,
  fallbackRequest: ValidatedRequest = request,
): FramingProviderAdapterResult {
  return {
    ok: false,
    suggestion: fallbackSuggestion(fallbackRequest, message),
    error: Object.freeze({
      code,
      message,
      requestedOwnerAdditions: PROVIDER_FRAMING_OWNER_ADDITIONS,
    }),
  };
}

function invalidRequestFailure(): FramingProviderAdapterResult {
  return {
    ok: false,
    error: Object.freeze({
      code: 'invalid-request',
      message: 'The framing request is incomplete or has invalid source identity, timing, frame, or provenance.',
      requestedOwnerAdditions: PROVIDER_FRAMING_OWNER_ADDITIONS,
    }),
  };
}

function providerAsFallbackRequest(
  provider: UnknownRecord,
  currentRequest: ValidatedRequest,
): ValidatedRequest {
  return {
    ...currentRequest,
    sourceMediaId: provider.sourceMediaId as string,
    takeId: provider.takeId as string,
    analysisId: provider.analysisId as string,
    analysisRevision: provider.analysisRevision as number,
    sourceDurationMs: provider.sourceDurationMs as number,
    selectedInterval: provider.selectedInterval as ProviderFramingInterval,
    intent: provider.intent as FramingIntent,
    frame: provider.frame as ProviderFramingFrame,
    provenance: provider.provenance as ProviderFramingProvenance,
  };
}

function providerHasBaseShape(provider: UnknownRecord): boolean {
  return provider.contractVersion === 1
    && isNonEmptyString(provider.sourceMediaId)
    && isNonEmptyString(provider.takeId)
    && isNonEmptyString(provider.analysisId)
    && isInteger(provider.analysisRevision)
    && provider.analysisRevision >= 0
    && isFiniteNumber(provider.sourceDurationMs)
    && provider.sourceDurationMs > 0
    && isValidInterval(provider.selectedInterval, provider.sourceDurationMs)
    && VALID_INTENTS.includes(provider.intent as FramingIntent)
    && isValidFrame(provider.frame)
    && isValidProvenance(provider.provenance)
    && typeof provider.originalFrameFallback === 'boolean';
}

function providerCropIsValid(provider: UnknownRecord): provider is UnknownRecord & {
  crop: ProviderFramingRect;
  confidence: number;
  reason: string;
} {
  return isValidRect(provider.crop)
    && isFiniteNumber(provider.confidence)
    && provider.confidence >= 0
    && provider.confidence <= 1
    && isNonEmptyString(provider.reason);
}

function parseProtectedRegions(value: unknown): ProviderFramingProtectedRegion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: ProviderFramingProtectedRegion[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)
      || !isNonEmptyString(entry.trackId)
      || ids.has(entry.trackId)
      || !VALID_KINDS.includes(entry.kind as FramingRegionKind)
      || !isValidRect(entry.rect)
      || !isFiniteNumber(entry.confidence)
      || entry.confidence < 0
      || entry.confidence > 1
      || typeof entry.relevant !== 'boolean') {
      return undefined;
    }
    ids.add(entry.trackId);
    result.push({
      trackId: entry.trackId,
      kind: entry.kind as FramingRegionKind,
      rect: entry.rect,
      confidence: entry.confidence,
      relevant: entry.relevant,
    });
  }
  return result;
}

function unionProofIsValid(
  value: unknown,
  selectedInterval: ProviderFramingInterval,
  regions: readonly ProviderFramingProtectedRegion[],
): boolean {
  if (!isRecord(value)
    || value.kind !== 'stable-union'
    || !sameInterval(value.interval, selectedInterval)
    || value.startBoundaryCovered !== true
    || value.endBoundaryCovered !== true
    || !Array.isArray(value.trackIds)
    || value.trackIds.length === 0
    || value.trackIds.some(trackId => !isNonEmptyString(trackId))) {
    return false;
  }
  const trackIds = value.trackIds as string[];
  if (new Set(trackIds).size !== trackIds.length) return false;
  const relevantIds = regions.filter(region => region.relevant).map(region => region.trackId);
  if (relevantIds.length === 0 || new Set(relevantIds).size !== relevantIds.length) return false;
  return trackIds.length === relevantIds.length && trackIds.every(trackId => relevantIds.includes(trackId));
}

function contains(outer: ProviderFramingRect, inner: ProviderFramingRect): boolean {
  return inner.x >= outer.x - EPSILON
    && inner.y >= outer.y - EPSILON
    && inner.x + inner.width <= outer.x + outer.width + EPSILON
    && inner.y + inner.height <= outer.y + outer.height + EPSILON;
}

function mapReadySuggestion(
  provider: UnknownRecord & { crop: ProviderFramingRect; confidence: number; reason: string },
  request: ValidatedRequest,
  regions: readonly ProviderFramingProtectedRegion[],
): AdaptedFramingSuggestion | undefined {
  const mappedRegions = regions.map(freezeRegion);
  const protectedKinds = [...new Set(regions.filter(region => region.relevant).map(region => region.kind))];
  if (protectedKinds.length === 0) return undefined;

  const captionSafeArea = provider.captionSafeArea as ProviderFramingRect;
  const suggestion = Object.freeze({
    version: FRAMING_SCHEMA_VERSION,
    mode: 'reframed' as const,
    sourceMediaId: request.sourceMediaId,
    takeId: request.takeId,
    analysisId: request.analysisId,
    analysisRevision: request.analysisRevision,
    sourceDurationSec: request.sourceDurationMs / 1000,
    startSec: request.selectedInterval.startMs / 1000,
    endSec: request.selectedInterval.endMs / 1000,
    interval: Object.freeze({
      startSec: request.selectedInterval.startMs / 1000,
      endSec: request.selectedInterval.endMs / 1000,
    }),
    intent: request.intent,
    frame: Object.freeze({
      uprightWidthPx: request.frame.uprightWidthPx,
      uprightHeightPx: request.frame.uprightHeightPx,
      rotationDegrees: request.frame.rotationDegrees,
    }),
    coverage: 'complete' as const,
    movement: 'stable' as const,
    protectedKinds: Object.freeze(protectedKinds),
    regions: Object.freeze(mappedRegions),
    crop: freezeRect(provider.crop),
    captionSafeArea: freezeRect(captionSafeArea),
    confidence: provider.confidence,
    status: 'ready' as const,
    provenance: sourceProvenance(request),
    reason: provider.reason,
    producerSource: request.provenance.source,
    producerModelVersion: request.provenance.modelVersion,
    ...(request.provenance.runtime ? { producerRuntime: request.provenance.runtime } : {}),
  });

  const validation = validateFramingSuggestion(suggestion);
  return validation.valid && validation.suggestion
    ? Object.freeze({
      ...validation.suggestion,
      mode: 'reframed' as const,
      startSec: request.selectedInterval.startMs / 1000,
      endSec: request.selectedInterval.endMs / 1000,
      analysisRevision: request.analysisRevision,
      producerSource: request.provenance.source,
      producerModelVersion: request.provenance.modelVersion,
      ...(request.provenance.runtime ? { producerRuntime: request.provenance.runtime } : {}),
    })
    : undefined;
}

/**
 * Convert a producer result into the consumer's source-local seconds contract.
 * Every failed path carries a current-identity original-frame suggestion when
 * the request is valid, so missing or stale media cannot be shown as playable.
 */
export function adaptProviderFramingSuggestion(
  providerOutput: unknown,
  currentRequest: unknown,
): FramingProviderAdapterResult {
  const request = validateRequest(currentRequest);
  if (!request) return invalidRequestFailure();

  if (!isRecord(providerOutput) || !providerHasBaseShape(providerOutput)) {
    return failure(request, 'invalid-provider', 'The framing provider result does not satisfy its published identity and geometry contract.');
  }

  if (!providerIdentityMatches(providerOutput, request)) {
    return failure(
      request,
      'identity-mismatch',
      'The framing result belongs to a different source, take, analysis, interval, frame, or provenance.',
      providerAsFallbackRequest(providerOutput, request),
    );
  }

  if (providerOutput.originalFrameFallback === true) {
    return failure(request, 'provider-fallback', 'The framing provider explicitly retained the original frame.');
  }

  if (!providerCropIsValid(providerOutput)) {
    return failure(request, 'invalid-provider', 'A ready framing result needs a normalized crop, bounded confidence, and a reason.');
  }

  if (providerOutput.coverage === undefined
    || providerOutput.movement === undefined
    || providerOutput.protectedRegions === undefined
    || providerOutput.unionProof === undefined) {
    return failure(request, 'missing-proof', 'The provider result lacks the explicit coverage, movement, region, and temporal union proof fields required by the consumer.');
  }
  if (providerOutput.coverage !== 'complete') {
    return failure(request, 'missing-coverage', 'The provider did not publish complete coverage for the selected interval.');
  }
  if (providerOutput.movement !== 'stable') {
    return failure(request, 'unsafe-movement', 'The provider did not publish stable movement evidence for one static crop.');
  }

  const regions = parseProtectedRegions(providerOutput.protectedRegions);
  if (!regions || !unionProofIsValid(providerOutput.unionProof, request.selectedInterval, regions)) {
    return failure(request, 'missing-proof', 'The provider result lacks a stable temporal union and protected-region boundary proof.');
  }

  if (!isValidRect(providerOutput.captionSafeArea)) {
    return failure(request, 'missing-caption-safe-area', 'The provider result lacks a normalized caption safe area.');
  }

  if (!regions.filter(region => region.relevant).every(region => contains(providerOutput.crop, region.rect))) {
    return failure(request, 'unsafe-crop', 'The provider crop does not contain every relevant protected region.');
  }
  if (!contains(providerOutput.crop, providerOutput.captionSafeArea)) {
    return failure(request, 'unsafe-crop', 'The provider crop does not contain the caption safe area.');
  }

  const suggestion = mapReadySuggestion(providerOutput, request, regions);
  if (!suggestion) {
    return failure(request, 'invalid-provider', 'The provider result could not be represented by the consumer framing contract.');
  }
  return { ok: true, suggestion };
}
