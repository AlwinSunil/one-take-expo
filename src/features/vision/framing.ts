/**
 * Additive, suggestion-only framing contract for selected takes.
 *
 * Coordinates are normalized against the upright, unmirrored source frame.
 * A result never changes media and is never a splice boundary. Consumers must
 * validate the result again before offering an explicit apply action.
 */

export const FRAMING_CONTRACT_VERSION = 1 as const;
export const FRAMING_COORDINATE_SPACE = 'normalized-upright-unmirrored' as const;

export type FramingIntent = 'talking-head' | 'vlog' | 'product-demo';
export type FramingRegionKind = 'face' | 'subject' | 'product' | 'hand';
export type FramingOrientation = 'portrait' | 'landscape';
export type RotationDegrees = 0 | 90 | 180 | 270;
export type FramingProcessor = 'cpu' | 'gpu' | 'npu' | 'unknown';
export type FramingProvenanceSource = 'fixture' | 'device';

export type FramingRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type FramingFrame = Readonly<{
  coordinateSpace: typeof FRAMING_COORDINATE_SPACE;
  orientation: FramingOrientation;
  rotationDegrees: RotationDegrees;
  uprightWidthPx: number;
  uprightHeightPx: number;
  aspectRatio: number;
}>;

export type FramingInterval = Readonly<{
  /** Milliseconds relative to the original source presentation timeline. */
  startMs: number;
  /** Exclusive end of the selected source interval. */
  endMs: number;
}>;

export type FramingProvenance = Readonly<{
  source: FramingProvenanceSource;
  model: string;
  modelVersion: string;
  /** The processor actually used for this analysis, not the desired backend. */
  processor: FramingProcessor;
  runtime?: string;
  fixtureId?: string;
}>;

export type FramingIdentity = Readonly<{
  sourceMediaId: string;
  takeId: string;
  analysisId: string;
  analysisRevision: number;
}>;

export type FramingAnalysisRequest = FramingIdentity & Readonly<{
  sourceDurationMs: number;
  selectedInterval: FramingInterval;
  intent: FramingIntent;
  frame: FramingFrame;
  provenance: FramingProvenance;
}>;

export type FramingRegionObservation = Readonly<{
  /** Stable for the life of a track within one analysis attempt. */
  timestampMs: number;
  rect: FramingRect;
  confidence: number;
}>;

export type FramingRegionTrack = Readonly<{
  /** Prevents tracks from a previous take or analysis from being reused. */
  identity: FramingIdentity;
  trackId: string;
  kind: FramingRegionKind;
  /** Explicit creator selection takes precedence over model relevance. */
  selected: boolean;
  /** Whether this region is relevant to the chosen shot intent. */
  relevant: boolean;
  observations: readonly FramingRegionObservation[];
}>;

export type FramingReason =
  | 'stable-union-crop'
  | 'talking-head-subject'
  | 'vlog-subject'
  | 'product-and-hands'
  | 'multiple-subjects-preserved'
  | 'feature-disabled'
  | 'invalid-request'
  | 'invalid-options'
  | 'invalid-provenance'
  | 'invalid-track'
  | 'identity-mismatch'
  | 'missing-detection'
  | 'no-relevant-subject'
  | 'product-not-selected'
  | 'hands-missing'
  | 'low-confidence'
  | 'off-frame'
  | 'discontinuous-track'
  | 'unsafe-multiple-subjects'
  | 'no-safe-crop'
  | 'target-aspect-unvalidated'
  | 'invalid-crop';

export const FRAMING_REASON_TEXT: Readonly<Record<FramingReason, string>> = {
  'stable-union-crop': 'Keep one stable crop around the selected regions.',
  'talking-head-subject': 'Keep the selected subject in view.',
  'vlog-subject': 'Keep the moving subject in view across the take.',
  'product-and-hands': 'Keep the selected product and relevant hands in view.',
  'multiple-subjects-preserved': 'Keep all selected subjects in the crop.',
  'feature-disabled': 'Framing suggestions are off.',
  'invalid-request': 'The source selection is not valid for framing analysis.',
  'invalid-options': 'The framing analysis settings are not valid.',
  'invalid-provenance': 'The framing analysis provenance is unavailable.',
  'invalid-track': 'The vision track data is not valid.',
  'identity-mismatch': 'This framing result belongs to a different source or selection.',
  'missing-detection': 'No reliable region was detected for this selection.',
  'no-relevant-subject': 'No selected subject is available for this shot intent.',
  'product-not-selected': 'Select the product before using a product-demo crop.',
  'hands-missing': 'Relevant hands were not tracked for the selected product.',
  'low-confidence': 'The detected regions are too uncertain for a safe crop.',
  'off-frame': 'A selected region leaves the source frame.',
  'discontinuous-track': 'The selected region is missing for part of the interval.',
  'unsafe-multiple-subjects': 'One crop cannot safely preserve all selected subjects.',
  'no-safe-crop': 'The original frame is the safest crop for this selection.',
  'target-aspect-unvalidated': 'This target aspect ratio is not validated for framing.',
  'invalid-crop': 'The suggested crop failed contract validation.',
};

export const ORIGINAL_FRAME_RECT: FramingRect = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

export const FRAMING_DEFAULTS = Object.freeze({
  enabled: false,
  /** Match the research stale-frame budget unless a producer proves another value. */
  maxObservationGapMs: 500,
  minConfidence: 0.75,
  margin: 0.06,
  maxZoom: 1.35,
});

export type FramingBuildOptions = Readonly<{
  /** Tier 1 remains opt-in until its acceptance and Tier 0 gates pass. */
  enabled?: boolean;
  maxObservationGapMs?: number;
  minConfidence?: number;
  /** Normalized margin added on each side of the union. */
  margin?: number;
  /** Maximum linear punch-in. */
  maxZoom?: number;
  /** Target conversion is outside v1. Equal source aspect is accepted only as a no-op. */
  targetAspectRatio?: number;
}>;

export type FramingSuggestion = Readonly<{
  contractVersion: typeof FRAMING_CONTRACT_VERSION;
  sourceMediaId: string;
  takeId: string;
  analysisId: string;
  analysisRevision: number;
  sourceDurationMs: number;
  selectedInterval: FramingInterval;
  intent: FramingIntent;
  frame: FramingFrame;
  crop: FramingRect;
  /** Minimum confidence across every supporting observation. */
  confidence: number;
  reason: FramingReason;
  reasons: readonly FramingReason[];
  reasonText: string;
  supportingTrackIds: readonly string[];
  /** Full original frame means no automatic edit should be offered. */
  originalFrameFallback: boolean;
  provenance: FramingProvenance;
}>;

export type FramingValidation = Readonly<{
  valid: boolean;
  reason?: FramingReason;
  errors: readonly string[];
}>;

type UnknownRecord = Record<string, unknown>;

const EPSILON = 1e-9;
const VALID_ROTATIONS: readonly number[] = [0, 90, 180, 270];
const VALID_KINDS: readonly string[] = ['face', 'subject', 'product', 'hand'];
const VALID_PROCESSORS: readonly string[] = ['cpu', 'gpu', 'npu', 'unknown'];
const VALID_PROVENANCE_SOURCES: readonly string[] = ['fixture', 'device'];
const VALID_REASONS: readonly string[] = [
  'stable-union-crop',
  'talking-head-subject',
  'vlog-subject',
  'product-and-hands',
  'multiple-subjects-preserved',
  'feature-disabled',
  'invalid-request',
  'invalid-options',
  'invalid-provenance',
  'invalid-track',
  'identity-mismatch',
  'missing-detection',
  'no-relevant-subject',
  'product-not-selected',
  'hands-missing',
  'low-confidence',
  'off-frame',
  'discontinuous-track',
  'unsafe-multiple-subjects',
  'no-safe-crop',
  'target-aspect-unvalidated',
  'invalid-crop',
];
const FALLBACK_REASONS: readonly FramingReason[] = [
  'feature-disabled',
  'invalid-request',
  'invalid-options',
  'invalid-provenance',
  'invalid-track',
  'identity-mismatch',
  'missing-detection',
  'no-relevant-subject',
  'product-not-selected',
  'hands-missing',
  'low-confidence',
  'off-frame',
  'discontinuous-track',
  'unsafe-multiple-subjects',
  'no-safe-crop',
  'target-aspect-unvalidated',
  'invalid-crop',
];
const MAX_CONTRACT_ZOOM = 1.35;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFramingReason(value: unknown): value is FramingReason {
  return typeof value === 'string' && VALID_REASONS.includes(value);
}

function validResult(errors: readonly string[], reason?: FramingReason): FramingValidation {
  return Object.freeze({ valid: errors.length === 0, reason, errors: [...errors] });
}

function validateRect(value: unknown, label: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${label} must be a rectangle`);
    return false;
  }
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)
    || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    errors.push(`${label} coordinates must be finite numbers`);
    return false;
  }
  if (width <= 0 || height <= 0) {
    errors.push(`${label} width and height must be positive`);
    return false;
  }
  if (x < 0 || y < 0 || x + width > 1 + EPSILON || y + height > 1 + EPSILON) {
    errors.push(`${label} must stay within the normalized source frame`);
    return false;
  }
  return true;
}

function validateFrame(value: unknown, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push('frame is required');
    return false;
  }
  if (value.coordinateSpace !== FRAMING_COORDINATE_SPACE) {
    errors.push('frame coordinateSpace must be normalized upright and unmirrored');
  }
  if (value.orientation !== 'portrait' && value.orientation !== 'landscape') {
    errors.push('frame orientation is invalid');
  }
  if (!VALID_ROTATIONS.includes(value.rotationDegrees as number)) {
    errors.push('frame rotationDegrees must be 0, 90, 180 or 270');
  }
  if (!isFiniteNumber(value.uprightWidthPx)
    || !isFiniteNumber(value.uprightHeightPx)
    || !Number.isInteger(value.uprightWidthPx)
    || !Number.isInteger(value.uprightHeightPx)
    || value.uprightWidthPx <= 0
    || value.uprightHeightPx <= 0) {
    errors.push('frame upright dimensions must be positive integers');
  }
  if (!isFiniteNumber(value.aspectRatio) || value.aspectRatio <= 0) {
    errors.push('frame aspectRatio must be positive and finite');
  } else if (isFiniteNumber(value.uprightWidthPx) && isFiniteNumber(value.uprightHeightPx)
    && Math.abs(value.aspectRatio - value.uprightWidthPx / value.uprightHeightPx) > EPSILON) {
    errors.push('frame aspectRatio must match upright dimensions');
  }
  if (value.orientation === 'portrait' && isFiniteNumber(value.uprightWidthPx)
    && isFiniteNumber(value.uprightHeightPx) && value.uprightWidthPx > value.uprightHeightPx) {
    errors.push('portrait frame dimensions are wider than tall');
  }
  if (value.orientation === 'landscape' && isFiniteNumber(value.uprightWidthPx)
    && isFiniteNumber(value.uprightHeightPx) && value.uprightHeightPx > value.uprightWidthPx) {
    errors.push('landscape frame dimensions are taller than wide');
  }
  return errors.length === 0;
}

function validateInterval(value: unknown, sourceDurationMs: unknown, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push('selectedInterval is required');
    return false;
  }
  const { startMs, endMs } = value;
  if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs)) {
    errors.push('selectedInterval boundaries must be finite numbers');
    return false;
  }
  if (!isFiniteNumber(sourceDurationMs) || sourceDurationMs <= 0) {
    errors.push('sourceDurationMs must be positive and finite');
    return false;
  }
  if (startMs < 0 || endMs > sourceDurationMs || endMs <= startMs) {
    errors.push('selectedInterval must be a non-empty half-open interval within the source');
    return false;
  }
  return true;
}

function validateProvenance(value: unknown, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push('provenance is required');
    return false;
  }
  if (!VALID_PROVENANCE_SOURCES.includes(value.source as string)) {
    errors.push('provenance source must be fixture or device');
  }
  if (!isNonEmptyString(value.model) || !isNonEmptyString(value.modelVersion)) {
    errors.push('provenance model and modelVersion are required');
  }
  if (!VALID_PROCESSORS.includes(value.processor as string)) {
    errors.push('provenance processor is invalid');
  }
  if (value.source === 'fixture' && value.processor !== 'cpu') {
    errors.push('fixture provenance must report host cpu execution');
  }
  if (value.runtime !== undefined && !isNonEmptyString(value.runtime)) {
    errors.push('provenance runtime must be a non-empty string when present');
  }
  if (value.fixtureId !== undefined && !isNonEmptyString(value.fixtureId)) {
    errors.push('provenance fixtureId must be a non-empty string when present');
  }
  return errors.length === 0;
}

/** Validates the immutable source and coordinate identity before analysis. */
export function validateFramingRequest(request: FramingAnalysisRequest): FramingValidation {
  const errors: string[] = [];
  if (!isRecord(request)) {
    return validResult(['request is required'], 'invalid-request');
  }
  for (const key of ['sourceMediaId', 'takeId', 'analysisId'] as const) {
    if (!isNonEmptyString(request[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (!isFiniteNumber(request.analysisRevision)
    || !Number.isInteger(request.analysisRevision)
    || request.analysisRevision < 0) {
    errors.push('analysisRevision must be a non-negative integer');
  }
  if (!validateInterval(request.selectedInterval, request.sourceDurationMs, errors)) {
    // The detailed interval error is sufficient for callers and keeps the
    // returned reason stable across malformed boundary combinations.
  }
  if (request.intent !== 'talking-head' && request.intent !== 'vlog' && request.intent !== 'product-demo') {
    errors.push('intent is invalid');
  }
  validateFrame(request.frame, errors);
  validateProvenance(request.provenance, errors);
  const reason = errors.some(error => error.startsWith('provenance'))
    ? 'invalid-provenance'
    : 'invalid-request';
  return validResult(errors, reason);
}

function trackErrorReason(errors: readonly string[]): FramingReason {
  if (errors.some(error => error.includes('identity'))) return 'identity-mismatch';
  if (errors.some(error => error.includes('within the normalized source frame'))) return 'off-frame';
  if (errors.some(error => error.includes('confidence'))) return 'low-confidence';
  return 'invalid-track';
}

/** Validates region bounds and stable track identity without interpreting intent. */
export function validateFramingTracks(
  request: FramingAnalysisRequest,
  tracks: readonly FramingRegionTrack[],
): FramingValidation {
  const requestValidation = validateFramingRequest(request);
  if (!requestValidation.valid) return requestValidation;
  const errors: string[] = [];
  if (!Array.isArray(tracks)) return validResult(['tracks must be an array'], 'invalid-track');
  const trackIds = new Set<string>();
  for (const track of tracks) {
    if (!isRecord(track)) {
      errors.push('track must be an object');
      continue;
    }
    if (!isNonEmptyString(track.trackId)) {
      errors.push('trackId must be a non-empty string');
    } else if (trackIds.has(track.trackId)) {
      errors.push(`duplicate trackId ${track.trackId}`);
    } else {
      trackIds.add(track.trackId);
    }
    if (!isRecord(track.identity)) {
      errors.push(`track ${String(track.trackId)} identity is required`);
    } else {
      for (const key of ['sourceMediaId', 'takeId', 'analysisId'] as const) {
        if (!isNonEmptyString(track.identity[key])) {
          errors.push(`track ${String(track.trackId)} identity ${key} is required`);
        } else if (track.identity[key] !== request[key]) {
          errors.push(`track ${String(track.trackId)} identity ${key} does not match request identity`);
        }
      }
      if (!isFiniteNumber(track.identity.analysisRevision)
        || !Number.isInteger(track.identity.analysisRevision)
        || track.identity.analysisRevision < 0) {
        errors.push(`track ${String(track.trackId)} identity analysisRevision is invalid`);
      } else if (track.identity.analysisRevision !== request.analysisRevision) {
        errors.push(`track ${String(track.trackId)} identity analysisRevision does not match request identity`);
      }
    }
    if (!VALID_KINDS.includes(track.kind as string)) errors.push('track kind is invalid');
    if (!isBoolean(track.selected) || !isBoolean(track.relevant)) {
      errors.push('track selected and relevant flags are required booleans');
    }
    if (!Array.isArray(track.observations)) {
      errors.push(`track ${String(track.trackId)} observations must be an array`);
      continue;
    }
    let previousTimestamp = -Infinity;
    for (const observation of track.observations) {
      if (!isRecord(observation)) {
        errors.push(`track ${String(track.trackId)} has a malformed observation`);
        continue;
      }
      if (!isFiniteNumber(observation.timestampMs)
        || observation.timestampMs < 0
        || observation.timestampMs >= request.sourceDurationMs) {
        errors.push(`track ${String(track.trackId)} has a timestamp outside the source`);
      } else if (observation.timestampMs <= previousTimestamp) {
        errors.push(`track ${String(track.trackId)} timestamps must increase strictly`);
      }
      if (isFiniteNumber(observation.timestampMs)) previousTimestamp = observation.timestampMs;
      validateRect(observation.rect, `track ${String(track.trackId)} observation`, errors);
      if (!isFiniteNumber(observation.confidence)
        || observation.confidence < 0
        || observation.confidence > 1) {
        errors.push(`track ${String(track.trackId)} confidence must be between 0 and 1`);
      }
    }
  }
  return validResult(errors, errors.length ? trackErrorReason(errors) : undefined);
}

function validateOptions(options: FramingBuildOptions | undefined): FramingValidation {
  const errors: string[] = [];
  if (options !== undefined && !isRecord(options)) {
    return validResult(['options must be an object'], 'invalid-options');
  }
  const value = options ?? {};
  if (value.enabled !== undefined && !isBoolean(value.enabled)) errors.push('enabled must be boolean');
  for (const [name, min, max] of [
    ['maxObservationGapMs', 0, FRAMING_DEFAULTS.maxObservationGapMs],
    ['minConfidence', FRAMING_DEFAULTS.minConfidence, 1],
    ['margin', FRAMING_DEFAULTS.margin, 0.5],
    ['maxZoom', 1, MAX_CONTRACT_ZOOM],
  ] as const) {
    const candidate = value[name];
    if (candidate !== undefined
      && (!isFiniteNumber(candidate) || candidate < min || candidate > max)) {
      errors.push(`${name} is outside its safe range`);
    }
  }
  if (value.targetAspectRatio !== undefined
    && (!isFiniteNumber(value.targetAspectRatio) || value.targetAspectRatio <= 0)) {
    errors.push('targetAspectRatio must be positive and finite');
  }
  return validResult(errors, errors.length ? 'invalid-options' : undefined);
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number' && Object.is(left, right);
}

function sameProvenance(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.source === right.source
    && left.model === right.model
    && left.modelVersion === right.modelVersion
    && left.processor === right.processor
    && left.runtime === right.runtime
    && left.fixtureId === right.fixtureId;
}

function sameFrame(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.coordinateSpace === right.coordinateSpace
    && left.orientation === right.orientation
    && left.rotationDegrees === right.rotationDegrees
    && sameNumber(left.uprightWidthPx, right.uprightWidthPx)
    && sameNumber(left.uprightHeightPx, right.uprightHeightPx)
    && typeof left.aspectRatio === 'number'
    && typeof right.aspectRatio === 'number'
    && Math.abs(left.aspectRatio - right.aspectRatio) <= EPSILON;
}

/**
 * Validates a suggestion against the exact source/take/interval identity.
 * This rejects late results after a camera rotation, take switch or new
 * analysis revision, even when the crop itself is geometrically valid.
 */
export function validateFramingSuggestion(
  suggestion: FramingSuggestion,
  expectedRequest: FramingAnalysisRequest,
): FramingValidation {
  const expectedValidation = validateFramingRequest(expectedRequest);
  if (!expectedValidation.valid) return expectedValidation;
  const errors: string[] = [];
  if (!isRecord(suggestion)) return validResult(['suggestion is required'], 'invalid-crop');
  if (suggestion.contractVersion !== FRAMING_CONTRACT_VERSION) errors.push('contractVersion is unsupported');
  for (const key of ['sourceMediaId', 'takeId', 'analysisId', 'analysisRevision', 'sourceDurationMs', 'intent'] as const) {
    if (suggestion[key] !== expectedRequest[key]) errors.push(`${key} does not match the request identity`);
  }
  const suggestionInterval = suggestion.selectedInterval;
  if (!isRecord(suggestionInterval)
    || !sameNumber(suggestionInterval.startMs, expectedRequest.selectedInterval.startMs)
    || !sameNumber(suggestionInterval.endMs, expectedRequest.selectedInterval.endMs)) {
    errors.push('selectedInterval does not match the request identity');
  }
  if (!sameFrame(suggestion.frame, expectedRequest.frame)) errors.push('frame orientation or geometry changed');
  if (!sameProvenance(suggestion.provenance, expectedRequest.provenance)) {
    errors.push('provenance does not match the request identity');
  }
  validateRect(suggestion.crop, 'suggestion crop', errors);
  if (isRecord(suggestion.crop)
    && Math.abs(Number(suggestion.crop.width) - Number(suggestion.crop.height)) > EPSILON) {
    errors.push('suggestion crop must preserve the original upright aspect ratio');
  }
  if (!isBoolean(suggestion.originalFrameFallback)) errors.push('originalFrameFallback must be boolean');
  if (suggestion.originalFrameFallback
    && isRecord(suggestion.crop)
    && !sameRect(suggestion.crop, ORIGINAL_FRAME_RECT)) {
    errors.push('fallback suggestions must use the full original frame');
  }
  if (isBoolean(suggestion.originalFrameFallback)) {
    if (suggestion.originalFrameFallback && !FALLBACK_REASONS.includes(suggestion.reason as FramingReason)) {
      errors.push('fallback suggestions must expose a fallback reason');
    }
    if (!suggestion.originalFrameFallback && FALLBACK_REASONS.includes(suggestion.reason as FramingReason)) {
      errors.push('non-fallback suggestions cannot expose a fallback reason');
    }
  }
  if (isRecord(suggestion.crop) && !suggestion.originalFrameFallback
    && (Number(suggestion.crop.width) < 1 / MAX_CONTRACT_ZOOM - EPSILON
      || Number(suggestion.crop.height) < 1 / MAX_CONTRACT_ZOOM - EPSILON)) {
    errors.push('suggestion crop exceeds the 1.35x maximum zoom');
  }
  if (!suggestion.originalFrameFallback
    && isRecord(suggestion.crop)
    && sameRect(suggestion.crop, ORIGINAL_FRAME_RECT)) {
    errors.push('non-fallback suggestions must contain a useful crop');
  }
  if (!isFiniteNumber(suggestion.confidence) || suggestion.confidence < 0 || suggestion.confidence > 1) {
    errors.push('suggestion confidence must be between 0 and 1');
  } else if (suggestion.originalFrameFallback && suggestion.confidence !== 0) {
    errors.push('fallback suggestions must have zero confidence');
  } else if (!suggestion.originalFrameFallback && suggestion.confidence < FRAMING_DEFAULTS.minConfidence) {
    errors.push(`non-fallback suggestions need confidence at least ${FRAMING_DEFAULTS.minConfidence}`);
  }
  if (!isFramingReason(suggestion.reason)) errors.push('suggestion reason is invalid');
  if (!Array.isArray(suggestion.reasons) || suggestion.reasons.length === 0
    || suggestion.reasons.some(reason => !isFramingReason(reason))) {
    errors.push('suggestion reasons must contain known reasons');
  } else if (!suggestion.reasons.includes(suggestion.reason)) {
    errors.push('suggestion reasons must include the primary reason');
  }
  if (!isNonEmptyString(suggestion.reasonText)) errors.push('suggestion reasonText is required');
  if (isFramingReason(suggestion.reason)
    && suggestion.reasonText !== FRAMING_REASON_TEXT[suggestion.reason]) {
    errors.push('suggestion reasonText does not match reason');
  }
  if (!Array.isArray(suggestion.supportingTrackIds)
    || suggestion.supportingTrackIds.some(trackId => !isNonEmptyString(trackId))) {
    errors.push('supportingTrackIds must contain stable non-empty ids');
  } else if (new Set(suggestion.supportingTrackIds).size !== suggestion.supportingTrackIds.length) {
    errors.push('supportingTrackIds must be unique');
  }
  if (!suggestion.originalFrameFallback
    && Array.isArray(suggestion.supportingTrackIds)
    && suggestion.supportingTrackIds.length === 0) {
    errors.push('non-fallback suggestions need supporting track ids');
  }
  return validResult(errors, errors.length ? 'identity-mismatch' : undefined);
}

/** Returns false for a result from a different immutable source identity. */
export function isFramingSuggestionCurrent(
  suggestion: FramingSuggestion,
  expectedRequest: FramingAnalysisRequest,
): boolean {
  return validateFramingSuggestion(suggestion, expectedRequest).valid;
}

function sameRect(left: unknown, right: FramingRect): boolean {
  if (!isRecord(left)) return false;
  return sameNumber(left.x, right.x)
    && sameNumber(left.y, right.y)
    && sameNumber(left.width, right.width)
    && sameNumber(left.height, right.height);
}

function fallbackRequest(request: unknown): FramingAnalysisRequest {
  if (isRecord(request)) {
    const frame = isRecord(request.frame) ? request.frame : {};
    const interval = isRecord(request.selectedInterval) ? request.selectedInterval : {};
    const provenance = isRecord(request.provenance) ? request.provenance : {};
    const width = isFiniteNumber(frame.uprightWidthPx) && frame.uprightWidthPx > 0
      ? Math.max(1, Math.round(frame.uprightWidthPx))
      : 1;
    const height = isFiniteNumber(frame.uprightHeightPx) && frame.uprightHeightPx > 0
      ? Math.max(1, Math.round(frame.uprightHeightPx))
      : 1;
    return {
      sourceMediaId: typeof request.sourceMediaId === 'string' ? request.sourceMediaId : '',
      takeId: typeof request.takeId === 'string' ? request.takeId : '',
      analysisId: typeof request.analysisId === 'string' ? request.analysisId : '',
      analysisRevision: isFiniteNumber(request.analysisRevision) ? request.analysisRevision : 0,
      sourceDurationMs: isFiniteNumber(request.sourceDurationMs) && request.sourceDurationMs > 0
        ? request.sourceDurationMs
        : 1,
      selectedInterval: {
        startMs: isFiniteNumber(interval.startMs) ? interval.startMs : 0,
        endMs: isFiniteNumber(interval.endMs) ? interval.endMs : 1,
      },
      intent: request.intent === 'talking-head' || request.intent === 'vlog' || request.intent === 'product-demo'
        ? request.intent
        : 'vlog',
      frame: {
        coordinateSpace: FRAMING_COORDINATE_SPACE,
        orientation: frame.orientation === 'portrait' ? 'portrait' : 'landscape',
        rotationDegrees: VALID_ROTATIONS.includes(frame.rotationDegrees as number)
          ? frame.rotationDegrees as RotationDegrees
          : 0,
        uprightWidthPx: width,
        uprightHeightPx: height,
        aspectRatio: width / height,
      },
      provenance: {
        source: provenance.source === 'device' ? 'device' : 'fixture',
        model: isNonEmptyString(provenance.model) ? provenance.model : 'unknown',
        modelVersion: isNonEmptyString(provenance.modelVersion) ? provenance.modelVersion : 'unknown',
        processor: provenance.processor === 'gpu' || provenance.processor === 'npu'
          || provenance.processor === 'unknown' ? provenance.processor : 'cpu',
      },
    };
  }
  return {
    sourceMediaId: '',
    takeId: '',
    analysisId: '',
    analysisRevision: 0,
    sourceDurationMs: 1,
    selectedInterval: { startMs: 0, endMs: 1 },
    intent: 'vlog',
    frame: {
      coordinateSpace: FRAMING_COORDINATE_SPACE,
      orientation: 'landscape',
      rotationDegrees: 0,
      uprightWidthPx: 1,
      uprightHeightPx: 1,
      aspectRatio: 1,
    },
    provenance: { source: 'fixture', model: 'unknown', modelVersion: 'unknown', processor: 'cpu' },
  };
}

function fallbackSuggestion(
  request: FramingAnalysisRequest,
  reason: FramingReason,
  extraReasons: readonly FramingReason[] = [],
): FramingSuggestion {
  const reasons = [...new Set<FramingReason>([reason, ...extraReasons])];
  return {
    contractVersion: FRAMING_CONTRACT_VERSION,
    sourceMediaId: request.sourceMediaId,
    takeId: request.takeId,
    analysisId: request.analysisId,
    analysisRevision: request.analysisRevision,
    sourceDurationMs: request.sourceDurationMs,
    selectedInterval: { ...request.selectedInterval },
    intent: request.intent,
    frame: { ...request.frame },
    crop: ORIGINAL_FRAME_RECT,
    confidence: 0,
    reason,
    reasons,
    reasonText: FRAMING_REASON_TEXT[reason],
    supportingTrackIds: [],
    originalFrameFallback: true,
    provenance: { ...request.provenance },
  };
}

function asOptions(options: FramingBuildOptions | undefined) {
  return {
    enabled: options?.enabled ?? FRAMING_DEFAULTS.enabled,
    maxObservationGapMs: options?.maxObservationGapMs ?? FRAMING_DEFAULTS.maxObservationGapMs,
    minConfidence: options?.minConfidence ?? FRAMING_DEFAULTS.minConfidence,
    margin: options?.margin ?? FRAMING_DEFAULTS.margin,
    maxZoom: options?.maxZoom ?? FRAMING_DEFAULTS.maxZoom,
    targetAspectRatio: options?.targetAspectRatio,
  };
}

type UnionRect = { minX: number; minY: number; maxX: number; maxY: number };

function unionRect(rects: readonly FramingRect[]): UnionRect {
  return rects.reduce((union, rect) => ({
    minX: Math.min(union.minX, rect.x),
    minY: Math.min(union.minY, rect.y),
    maxX: Math.max(union.maxX, rect.x + rect.width),
    maxY: Math.max(union.maxY, rect.y + rect.height),
  }), { minX: 1, minY: 1, maxX: 0, maxY: 0 });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function buildStableCrop(
  rects: readonly FramingRect[],
  margin: number,
  maxZoom: number,
): FramingRect | null {
  const union = unionRect(rects);
  const unionWidth = union.maxX - union.minX;
  const unionHeight = union.maxY - union.minY;
  const minSizeForZoom = 1 / maxZoom;
  // Normalized width and height use their own source axes. Preserving the
  // source pixel aspect therefore means equal normalized crop dimensions.
  const requestedSize = Math.max(unionWidth, unionHeight, minSizeForZoom) + 2 * margin;
  if (requestedSize >= 1 - EPSILON) return null;

  const centerX = (union.minX + union.maxX) / 2;
  const centerY = (union.minY + union.maxY) / 2;
  const x = clamp(centerX - requestedSize / 2, 0, 1 - requestedSize);
  const y = clamp(centerY - requestedSize / 2, 0, 1 - requestedSize);
  const crop = { x, y, width: requestedSize, height: requestedSize };
  // Keep this invariant local so future changes cannot silently clip a track.
  if (crop.x > union.minX + EPSILON
    || crop.y > union.minY + EPSILON
    || crop.x + crop.width < union.maxX - EPSILON
    || crop.y + crop.height < union.maxY - EPSILON) return null;
  return crop;
}

function samplesForTrack(
  track: FramingRegionTrack,
  interval: FramingInterval,
  minConfidence: number,
  maxObservationGapMs: number,
): { samples: readonly FramingRegionObservation[]; reason?: FramingReason } {
  const samples = track.observations.filter(observation =>
    observation.timestampMs >= interval.startMs && observation.timestampMs < interval.endMs);
  if (samples.length === 0) return { samples, reason: 'missing-detection' };
  if (samples.some(sample => sample.confidence < minConfidence)) {
    return { samples, reason: 'low-confidence' };
  }
  const points = [interval.startMs, ...samples.map(sample => sample.timestampMs), interval.endMs];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index] - points[index - 1] > maxObservationGapMs + EPSILON) {
      return { samples, reason: 'discontinuous-track' };
    }
  }
  return { samples };
}

/**
 * Produces one static union crop for the selected interval. The default is
 * disabled and returns the original frame, which keeps developmental fixture
 * providers from changing recording or export behavior accidentally.
 */
export function buildFramingSuggestion(
  request: FramingAnalysisRequest,
  tracks: readonly FramingRegionTrack[],
  options: FramingBuildOptions = {},
): FramingSuggestion {
  if (!isRecord(request)) return fallbackSuggestion(fallbackRequest(request), 'invalid-request');
  const requestValidation = validateFramingRequest(request);
  if (!requestValidation.valid) {
    return fallbackSuggestion(request, requestValidation.reason ?? 'invalid-request');
  }
  const optionsValidation = validateOptions(options);
  if (!optionsValidation.valid) return fallbackSuggestion(request, 'invalid-options');
  const resolved = asOptions(options);
  if (resolved.targetAspectRatio !== undefined
    && Math.abs(resolved.targetAspectRatio - request.frame.aspectRatio) > EPSILON) {
    return fallbackSuggestion(request, 'target-aspect-unvalidated');
  }
  if (!resolved.enabled) return fallbackSuggestion(request, 'feature-disabled');

  const tracksValidation = validateFramingTracks(request, tracks);
  if (!tracksValidation.valid) {
    return fallbackSuggestion(request, tracksValidation.reason ?? 'invalid-track');
  }

  const eligible = tracks.filter(track => track.selected || track.relevant);
  let required: FramingRegionTrack[];
  if (request.intent === 'product-demo') {
    if (!tracks.some(track => track.kind === 'product' && track.selected)) {
      return fallbackSuggestion(request, 'product-not-selected');
    }
    if (!tracks.some(track => track.kind === 'hand' && track.relevant)) {
      return fallbackSuggestion(request, 'hands-missing');
    }
    required = eligible.filter(track =>
      track.kind === 'face' || track.kind === 'subject' || track.kind === 'product' || track.kind === 'hand');
    // Product and hands are required. A selected presenter is optional, but
    // when supplied it is preserved in the same static crop.
    if (!required.some(track => track.kind === 'product' && track.selected)) {
      return fallbackSuggestion(request, 'product-not-selected');
    }
    if (!required.some(track => track.kind === 'hand' && track.relevant)) {
      return fallbackSuggestion(request, 'hands-missing');
    }
  } else {
    required = eligible.filter(track => track.kind === 'face' || track.kind === 'subject');
    if (required.length === 0) {
      return fallbackSuggestion(request, tracks.length === 0 ? 'missing-detection' : 'no-relevant-subject');
    }
  }

  if (required.length === 0) {
    return fallbackSuggestion(request, request.intent === 'product-demo' ? 'hands-missing' : 'no-relevant-subject');
  }
  const selectedSamples: { track: FramingRegionTrack; samples: readonly FramingRegionObservation[] }[] = [];
  for (const track of required) {
    const sampleResult = samplesForTrack(
      track,
      request.selectedInterval,
      resolved.minConfidence,
      resolved.maxObservationGapMs,
    );
    if (sampleResult.reason) {
      return fallbackSuggestion(request, sampleResult.reason);
    }
    selectedSamples.push({ track, samples: sampleResult.samples });
  }

  const regions = selectedSamples.flatMap(item => item.samples.map(sample => sample.rect));
  const crop = buildStableCrop(regions, resolved.margin, resolved.maxZoom);
  const multipleSubjects = required.filter(track => track.kind === 'face' || track.kind === 'subject').length > 1;
  if (!crop) {
    return fallbackSuggestion(request, multipleSubjects ? 'unsafe-multiple-subjects' : 'no-safe-crop');
  }

  const confidence = selectedSamples.reduce((minimum, item) =>
    item.samples.reduce((value, sample) => Math.min(value, sample.confidence), minimum), 1);
  const semanticReason: FramingReason = request.intent === 'talking-head'
    ? 'talking-head-subject'
    : request.intent === 'vlog'
      ? 'vlog-subject'
      : 'product-and-hands';
  const reasons: FramingReason[] = [semanticReason, 'stable-union-crop'];
  if (multipleSubjects) reasons.push('multiple-subjects-preserved');
  const supportingTrackIds = selectedSamples
    .map(item => item.track.trackId)
    .sort((left, right) => left.localeCompare(right));
  return {
    contractVersion: FRAMING_CONTRACT_VERSION,
    sourceMediaId: request.sourceMediaId,
    takeId: request.takeId,
    analysisId: request.analysisId,
    analysisRevision: request.analysisRevision,
    sourceDurationMs: request.sourceDurationMs,
    selectedInterval: { ...request.selectedInterval },
    intent: request.intent,
    frame: { ...request.frame },
    crop,
    confidence,
    reason: semanticReason,
    reasons,
    reasonText: FRAMING_REASON_TEXT[semanticReason],
    supportingTrackIds,
    originalFrameFallback: false,
    provenance: { ...request.provenance },
  };
}
