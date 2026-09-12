/**
 * Provider-neutral Tier 1 framing seam.
 *
 * A producer supplies one crop suggestion for one source-local interval. The
 * review/export lane validates that suggestion and turns it into one immutable
 * decision per cut. No face, product, hand, movement, or confidence value is
 * inferred here. The producer owns those observations; this module only
 * applies conservative consumer safety rules.
 *
 * A capture producer that reports milliseconds must convert them to these
 * source-local seconds before calling this module. The conversion belongs at
 * that adapter boundary and must preserve the same half-open interval and
 * source/take identity; recognition timestamps are never accepted as a crop
 * boundary.
 */

export const FRAMING_SCHEMA_VERSION = 1 as const;
export const MAX_FRAMING_ZOOM = 1.35;
const EPSILON = 1e-6;
const NORMALIZED_ASPECT_EPSILON = 1e-6;

export type FramingCrop = Readonly<{
  /** Normalized x coordinate in the upright, unmirrored source frame. */
  x: number;
  /** Normalized y coordinate in the upright, unmirrored source frame. */
  y: number;
  width: number;
  height: number;
}>;

export const ORIGINAL_FRAMING_CROP: FramingCrop = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

export type FramingSourceInterval = Readonly<{
  /** Seconds relative to the original source media, not wall clock time. */
  startSec: number;
  /** Exclusive end in seconds relative to the original source media. */
  endSec: number;
}>;

export type FramingIntent = 'talking-head' | 'vlog' | 'product-demo';
export type FramingRegionKind = 'face' | 'subject' | 'product' | 'hand';
export type FramingSuggestionStatus = 'ready' | 'pending' | 'uncertain' | 'unavailable' | 'failed';
export type FramingCoverage = 'complete' | 'partial' | 'missing' | 'unknown';
export type FramingMovement = 'stable' | 'moving' | 'unknown';

export interface FramingFrame {
  readonly uprightWidthPx: number;
  readonly uprightHeightPx: number;
  /** Rotation applied to encoded media to obtain the upright source frame. */
  readonly rotationDegrees: 0 | 90 | 180 | 270;
}

export interface FramingRegion {
  readonly trackId: string;
  readonly kind: FramingRegionKind;
  /** Union region for the full suggestion interval, not a per-frame box. */
  readonly rect: FramingCrop;
  readonly confidence: number;
  /** Producer and creator selection identify whether this region is relevant. */
  readonly relevant: boolean;
}

export interface FramingProvenance {
  readonly provider: 'fixture' | 'device';
  readonly model: string;
  readonly processor: 'cpu' | 'gpu' | 'npu' | 'unknown';
}

export interface FramingSuggestion {
  readonly version: typeof FRAMING_SCHEMA_VERSION;
  readonly sourceMediaId: string;
  readonly takeId: string;
  /** New identity for each producer analysis attempt. */
  readonly analysisId: string;
  readonly sourceDurationSec: number;
  readonly interval: FramingSourceInterval;
  readonly intent: FramingIntent;
  readonly frame: FramingFrame;
  readonly coverage: FramingCoverage;
  readonly movement: FramingMovement;
  readonly protectedKinds: readonly FramingRegionKind[];
  readonly regions: readonly FramingRegion[];
  /** Optional for non-ready states; required before a crop can be applied. */
  readonly crop?: FramingCrop;
  /** Source-frame rectangle reserved for caption rendering. */
  readonly captionSafeArea?: FramingCrop;
  readonly confidence?: number;
  readonly status: FramingSuggestionStatus;
  readonly provenance: FramingProvenance;
  readonly reason?: string;
}

export interface FramingCutInput {
  readonly sourceMediaId: string;
  readonly takeId?: string;
  readonly startSec: number;
  readonly endSec: number;
  /** Media availability belongs to the storage owner; false always falls back. */
  readonly mediaAvailable?: boolean;
}

export interface FramingPlanInput {
  readonly sourceMediaId: string;
  readonly cuts: readonly FramingCutInput[];
  /** Unknown rows are accepted so persisted/provider payloads are validated at the seam. */
  readonly suggestions?: readonly unknown[];
  /** Defaults to false. Callers must pass an explicit development opt-in. */
  readonly enabled?: boolean;
}

export type FramingFallbackReason =
  | 'disabled'
  | 'missing-media'
  | 'missing-suggestion'
  | 'interval-not-covered'
  | 'ambiguous-suggestion'
  | 'invalid-suggestion'
  | 'uncertain-evidence'
  | 'missing-coverage'
  | 'moving-subject'
  | 'protected-region-outside-crop'
  | 'caption-safe-area-outside-crop';

/** Coordinates expected by Media3's Crop effect. */
export interface NativeFramingCrop {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

export interface FramingDecision {
  readonly sourceMediaId: string;
  readonly takeId?: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly mode: 'original' | 'reframed';
  /** This is the exact crop to use for the complete source cut. */
  readonly crop: FramingCrop;
  /** Derived once from `crop`; preview and export must reuse this value. */
  readonly nativeCrop: NativeFramingCrop;
  readonly suggestionId?: string;
  readonly fallbackReason?: FramingFallbackReason;
}

export interface FramingPlan {
  readonly version: typeof FRAMING_SCHEMA_VERSION;
  readonly sourceMediaId: string;
  readonly enabled: boolean;
  readonly cuts: readonly FramingDecision[];
}

export interface FramingValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly suggestion?: FramingSuggestion;
}

export type FramingPlanErrorCode = 'invalid-source' | 'invalid-cut';

export class FramingPlanError extends Error {
  readonly code: FramingPlanErrorCode;

  constructor(code: FramingPlanErrorCode, message: string) {
    super(message);
    this.name = 'FramingPlanError';
    this.code = code;
  }
}

const INTENTS: readonly FramingIntent[] = ['talking-head', 'vlog', 'product-demo'];
const REGION_KINDS: readonly FramingRegionKind[] = ['face', 'subject', 'product', 'hand'];
const STATUSES: readonly FramingSuggestionStatus[] = ['ready', 'pending', 'uncertain', 'unavailable', 'failed'];
const COVERAGE: readonly FramingCoverage[] = ['complete', 'partial', 'missing', 'unknown'];
const MOVEMENT: readonly FramingMovement[] = ['stable', 'moving', 'unknown'];
const PROCESSORS: readonly FramingProvenance['processor'][] = ['cpu', 'gpu', 'npu', 'unknown'];
const PROTECTED_KINDS: readonly FramingRegionKind[] = ['face', 'subject', 'product', 'hand'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function readInterval(value: unknown): FramingSourceInterval | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.startSec) || !isFiniteNumber(value.endSec)) return undefined;
  return { startSec: value.startSec, endSec: value.endSec };
}

function readIdentity(value: unknown): { sourceMediaId?: string; takeId?: string; analysisId?: string; interval?: FramingSourceInterval } {
  if (!isRecord(value)) return {};
  return {
    sourceMediaId: nonEmptyString(value.sourceMediaId) ? value.sourceMediaId : undefined,
    takeId: nonEmptyString(value.takeId) ? value.takeId : undefined,
    analysisId: nonEmptyString(value.analysisId) ? value.analysisId : undefined,
    interval: readInterval(value.interval),
  };
}

function validateRect(value: unknown, label: string, errors: string[]): value is FramingCrop {
  if (!isRecord(value)) {
    errors.push(`${label} must be a rectangle.`);
    return false;
  }
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
    errors.push(`${label} coordinates must be finite numbers.`);
    return false;
  }
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
    || value.x + value.width > 1 || value.y + value.height > 1) {
    errors.push(`${label} must stay inside normalized source bounds.`);
    return false;
  }
  return true;
}

function validateFrame(value: unknown, errors: string[]): value is FramingFrame {
  if (!isRecord(value) || !isFiniteNumber(value.uprightWidthPx) || !isFiniteNumber(value.uprightHeightPx)
    || value.uprightWidthPx <= 0 || value.uprightHeightPx <= 0
    || ![0, 90, 180, 270].includes(value.rotationDegrees as number)) {
    errors.push('frame must contain positive upright dimensions and a 0/90/180/270 rotation.');
    return false;
  }
  return true;
}

function validateInterval(value: unknown, duration: unknown, errors: string[]): value is FramingSourceInterval {
  const interval = readInterval(value);
  if (!interval || !isFiniteNumber(duration) || duration <= 0) {
    errors.push('source duration and interval must be finite positive seconds.');
    return false;
  }
  if (interval.startSec < 0 || interval.endSec <= interval.startSec || interval.endSec > duration) {
    errors.push('interval must be within source duration and use an exclusive end.');
    return false;
  }
  return true;
}

function validateProvenance(value: unknown, errors: string[]): value is FramingProvenance {
  if (!isRecord(value) || !isOneOf(value.provider, ['fixture', 'device'] as const)
    || !nonEmptyString(value.model) || !isOneOf(value.processor, PROCESSORS)) {
    errors.push('provenance must identify fixture/device, model, and processor.');
    return false;
  }
  return true;
}

function cloneRect(value: FramingCrop): FramingCrop {
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

function cloneSuggestion(value: Record<string, unknown>, frame: FramingFrame, interval: FramingSourceInterval,
  crop: FramingCrop | undefined, captionSafeArea: FramingCrop | undefined, regions: readonly FramingRegion[],
  protectedKinds: readonly FramingRegionKind[], provenance: FramingProvenance): FramingSuggestion {
  return Object.freeze({
    version: FRAMING_SCHEMA_VERSION,
    sourceMediaId: value.sourceMediaId as string,
    takeId: value.takeId as string,
    analysisId: value.analysisId as string,
    sourceDurationSec: value.sourceDurationSec as number,
    interval: Object.freeze({ ...interval }),
    intent: value.intent as FramingIntent,
    frame: Object.freeze({ ...frame }),
    coverage: value.coverage as FramingCoverage,
    movement: value.movement as FramingMovement,
    protectedKinds: Object.freeze([...protectedKinds]),
    regions: Object.freeze(regions.map(region => Object.freeze({
      ...region,
      rect: cloneRect(region.rect),
    }))),
    ...(crop ? { crop: cloneRect(crop) } : {}),
    ...(captionSafeArea ? { captionSafeArea: cloneRect(captionSafeArea) } : {}),
    ...(isFiniteNumber(value.confidence) ? { confidence: value.confidence } : {}),
    status: value.status as FramingSuggestionStatus,
    provenance: Object.freeze({ ...provenance }),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  });
}

/**
 * Validate a provider payload without making any claim about detector/model
 * quality. A ready row must contain enough evidence for the consumer policy;
 * pending and unavailable rows may omit crop geometry and still explain why
 * the consumer should preserve the original frame.
 */
export function validateFramingSuggestion(input: unknown): FramingValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ['suggestion must be an object.'] };

  if (input.version !== FRAMING_SCHEMA_VERSION) errors.push('version must be 1.');
  if (!nonEmptyString(input.sourceMediaId)) errors.push('sourceMediaId is required.');
  if (!nonEmptyString(input.takeId)) errors.push('takeId is required.');
  if (!nonEmptyString(input.analysisId)) errors.push('analysisId is required.');
  const sourceDurationSec = input.sourceDurationSec;
  const interval = validateInterval(input.interval, sourceDurationSec, errors) ? readInterval(input.interval)! : undefined;
  const intent = isOneOf(input.intent, INTENTS) ? input.intent : undefined;
  if (!intent) errors.push('intent is invalid.');
  const frame = validateFrame(input.frame, errors) ? input.frame as FramingFrame : undefined;
  const coverage = isOneOf(input.coverage, COVERAGE) ? input.coverage : undefined;
  if (!coverage) errors.push('coverage is invalid.');
  const movement = isOneOf(input.movement, MOVEMENT) ? input.movement : undefined;
  if (!movement) errors.push('movement is invalid.');
  const status = isOneOf(input.status, STATUSES) ? input.status : undefined;
  if (!status) errors.push('status is invalid.');
  if (!validateProvenance(input.provenance, errors)) return { valid: false, errors };

  const protectedKinds: FramingRegionKind[] = [];
  if (!Array.isArray(input.protectedKinds)) {
    if (status === 'ready') errors.push('protectedKinds must contain at least one region kind.');
  } else {
    if (input.protectedKinds.length === 0 && status === 'ready') errors.push('protectedKinds must contain at least one region kind.');
    for (const kind of input.protectedKinds) {
      if (!isOneOf(kind, REGION_KINDS)) errors.push('protectedKinds contains an invalid region kind.');
      else if (!protectedKinds.includes(kind)) protectedKinds.push(kind);
    }
  }

  const regions: FramingRegion[] = [];
  if (!Array.isArray(input.regions)) {
    if (status === 'ready') errors.push('regions must be an array.');
  } else {
    input.regions.forEach((value, index) => {
      if (!isRecord(value) || !nonEmptyString(value.trackId) || !isOneOf(value.kind, REGION_KINDS)
        || typeof value.relevant !== 'boolean' || !isFiniteNumber(value.confidence)) {
        errors.push(`region ${index + 1} is invalid.`);
        return;
      }
      const rectErrors: string[] = [];
      if (!validateRect(value.rect, `region ${index + 1}`, rectErrors)) {
        errors.push(...rectErrors);
        return;
      }
      if (value.confidence < 0 || value.confidence > 1) {
        errors.push(`region ${index + 1} confidence must be between 0 and 1.`);
        return;
      }
      regions.push({
        trackId: value.trackId,
        kind: value.kind,
        rect: value.rect,
        confidence: value.confidence,
        relevant: value.relevant,
      });
    });
  }

  let crop: FramingCrop | undefined;
  if (input.crop !== undefined) {
    const cropErrors: string[] = [];
    if (validateRect(input.crop, 'crop', cropErrors)) crop = input.crop;
    errors.push(...cropErrors);
  }
  let captionSafeArea: FramingCrop | undefined;
  if (input.captionSafeArea !== undefined) {
    const safeErrors: string[] = [];
    if (validateRect(input.captionSafeArea, 'captionSafeArea', safeErrors)) captionSafeArea = input.captionSafeArea;
    errors.push(...safeErrors);
  }
  if (status === 'ready') {
    if (!crop) errors.push('ready suggestions require a crop.');
    if (!captionSafeArea) errors.push('ready suggestions require a captionSafeArea.');
    // x/y are independent fractions of the same source frame, so equal
    // fractions preserve the source pixel aspect ratio without inventing a
    // target viewport conversion.
    if (crop && Math.abs(crop.width - crop.height) > NORMALIZED_ASPECT_EPSILON) {
      errors.push('crop must preserve the original source aspect ratio.');
    }
    if (crop && 1 / Math.min(crop.width, crop.height) > MAX_FRAMING_ZOOM + EPSILON) {
      errors.push(`crop zoom must not exceed ${MAX_FRAMING_ZOOM}x.`);
    }
    if (!isFiniteNumber(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      errors.push('ready suggestions require confidence between 0 and 1.');
    }
  } else if (input.confidence !== undefined && (!isFiniteNumber(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    errors.push('confidence must be between 0 and 1.');
  }

  if (errors.length > 0 || !interval || !frame || !intent || !coverage || !movement || !status
    || !nonEmptyString(input.sourceMediaId) || !nonEmptyString(input.takeId) || !nonEmptyString(input.analysisId)) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    suggestion: cloneSuggestion(input, frame, interval, crop, captionSafeArea, regions, protectedKinds, input.provenance),
  };
}

function contains(outer: FramingCrop, inner: FramingCrop): boolean {
  return inner.x >= outer.x - EPSILON
    && inner.y >= outer.y - EPSILON
    && inner.x + inner.width <= outer.x + outer.width + EPSILON
    && inner.y + inner.height <= outer.y + outer.height + EPSILON;
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Convert top-left normalized source coordinates to the Media3 Crop effect's
 * centered coordinates. The y axis is inverted exactly once here. This value
 * is derived from the same decision used by preview and export.
 */
export function toNativeCrop(crop: FramingCrop): NativeFramingCrop {
  const errors: string[] = [];
  if (!validateRect(crop, 'crop', errors)) throw new FramingPlanError('invalid-cut', errors[0] ?? 'Crop is invalid.');
  return Object.freeze({
    left: roundCoordinate(crop.x * 2 - 1),
    right: roundCoordinate((crop.x + crop.width) * 2 - 1),
    bottom: roundCoordinate(1 - (crop.y + crop.height) * 2),
    top: roundCoordinate(1 - crop.y * 2),
  });
}

function originalDecision(cut: FramingCutInput, fallbackReason: FramingFallbackReason): FramingDecision {
  return Object.freeze({
    sourceMediaId: cut.sourceMediaId,
    ...(cut.takeId ? { takeId: cut.takeId } : {}),
    startSec: cut.startSec,
    endSec: cut.endSec,
    mode: 'original',
    crop: ORIGINAL_FRAMING_CROP,
    nativeCrop: toNativeCrop(ORIGINAL_FRAMING_CROP),
    fallbackReason,
  });
}

function cutIsCovered(cut: FramingCutInput, interval: FramingSourceInterval): boolean {
  return cut.startSec >= interval.startSec - EPSILON && cut.endSec <= interval.endSec + EPSILON;
}

function fallbackForSuggestion(suggestion: FramingSuggestion): FramingFallbackReason | undefined {
  if (suggestion.status !== 'ready') return 'uncertain-evidence';
  if (suggestion.coverage !== 'complete') return 'missing-coverage';
  if (suggestion.movement === 'unknown') return 'uncertain-evidence';
  if (suggestion.movement === 'moving') return 'moving-subject';
  if (!suggestion.crop || !suggestion.captionSafeArea) return 'invalid-suggestion';

  for (const kind of suggestion.protectedKinds) {
    if (!suggestion.regions.some(region => region.relevant && region.kind === kind)) return 'missing-coverage';
  }
  for (const region of suggestion.regions) {
    if (region.relevant && PROTECTED_KINDS.includes(region.kind) && !contains(suggestion.crop, region.rect)) {
      return 'protected-region-outside-crop';
    }
  }
  if (!contains(suggestion.crop, suggestion.captionSafeArea)) return 'caption-safe-area-outside-crop';
  return undefined;
}

interface ParsedSuggestion {
  readonly sourceMediaId?: string;
  readonly takeId?: string;
  readonly interval?: FramingSourceInterval;
  readonly valid: boolean;
  readonly suggestion?: FramingSuggestion;
}

/**
 * Build the review/export framing plan. A plan never mutates the original
 * media or silently turns an invalid provider row into a crop. Preview and
 * export should serialize the returned decisions, preserving one crop for the
 * complete source interval represented by each cut.
 */
export function buildFramingPlan(input: FramingPlanInput): FramingPlan {
  if (!isRecord(input) || !nonEmptyString(input.sourceMediaId)) {
    throw new FramingPlanError('invalid-source', 'A source media identity is required.');
  }
  if (!Array.isArray(input.cuts)) {
    throw new FramingPlanError('invalid-cut', 'Framing cuts must be an array.');
  }
  const cuts = input.cuts.map((cut, index) => {
    if (!isRecord(cut) || !nonEmptyString(cut.sourceMediaId)
      || !isFiniteNumber(cut.startSec) || !isFiniteNumber(cut.endSec)
      || cut.startSec < 0 || cut.endSec <= cut.startSec
      || (cut.takeId !== undefined && !nonEmptyString(cut.takeId))) {
      throw new FramingPlanError('invalid-cut', `Framing cut ${index + 1} is invalid.`);
    }
    return cut as unknown as FramingCutInput;
  });

  const suggestionRows = input.suggestions === undefined
    ? []
    : Array.isArray(input.suggestions)
      ? input.suggestions
      : [];
  const parsed: ParsedSuggestion[] = suggestionRows.map(value => {
    const identity = readIdentity(value);
    const validation = validateFramingSuggestion(value);
    return {
      sourceMediaId: identity.sourceMediaId,
      takeId: identity.takeId,
      interval: identity.interval,
      valid: validation.valid,
      suggestion: validation.suggestion,
    };
  });
  const enabled = input.enabled === true;

  const decisions = cuts.map(cut => {
    if (cut.mediaAvailable === false) return originalDecision(cut, 'missing-media');
    if (!enabled) return originalDecision(cut, 'disabled');
    if (cut.sourceMediaId !== input.sourceMediaId) return originalDecision(cut, 'missing-suggestion');

    const identityMatches = parsed.filter(candidate => candidate.sourceMediaId === cut.sourceMediaId
      && (cut.takeId === undefined || candidate.takeId === cut.takeId));
    if (identityMatches.length === 0) return originalDecision(cut, 'missing-suggestion');

    const covered = identityMatches.filter(candidate => candidate.interval && cutIsCovered(cut, candidate.interval));
    if (covered.length === 0) {
      return originalDecision(cut, identityMatches.some(candidate => !candidate.valid) ? 'invalid-suggestion' : 'interval-not-covered');
    }
    if (covered.length > 1) return originalDecision(cut, 'ambiguous-suggestion');
    const candidate = covered[0];
    if (!candidate.valid || !candidate.suggestion) return originalDecision(cut, 'invalid-suggestion');
    const suggestion = candidate.suggestion;
    const fallbackReason = fallbackForSuggestion(suggestion);
    if (fallbackReason) return originalDecision(cut, fallbackReason);

    const crop = suggestion.crop!;
    return Object.freeze({
      sourceMediaId: cut.sourceMediaId,
      ...(cut.takeId ? { takeId: cut.takeId } : {}),
      startSec: cut.startSec,
      endSec: cut.endSec,
      mode: 'reframed' as const,
      crop: cloneRect(crop),
      nativeCrop: toNativeCrop(crop),
      suggestionId: suggestion.analysisId,
    });
  });

  return Object.freeze({
    version: FRAMING_SCHEMA_VERSION,
    sourceMediaId: input.sourceMediaId,
    enabled,
    cuts: Object.freeze(decisions),
  });
}
