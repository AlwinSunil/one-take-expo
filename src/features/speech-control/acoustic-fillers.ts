/**
 * Boundary-safe adapter for a saved-audio acoustic filler detector.
 *
 * The detector owns only acoustic observations.  This module validates the
 * versioned result, keeps its source/revision identity, and turns ready
 * events into review marks for the existing cleanup producer.  It never
 * changes a transcript and never supplies a splice boundary.
 */

import type { CleanupMarkInput } from './cleanup.ts';

export const ACOUSTIC_FILLER_SCHEMA_VERSION = 1 as const;
export const ACOUSTIC_FILLER_MAX_DURATION_SECONDS = 24 * 60 * 60;
export const ACOUSTIC_FILLER_MAX_EVENTS = 100_000;
export const ACOUSTIC_FILLER_MAX_TIMING_RESOLUTION_SECONDS = 60;

export type AcousticFillerLabel = 'um' | 'uh';
export type AcousticFillerStatus = 'ready' | 'unavailable';
export type AcousticFillerProcessor = 'cpu' | 'gpu' | 'npu' | 'unknown';
export type AcousticFillerProvenanceSource = 'fixture' | 'device' | 'host-audio';

export interface AcousticFillerModel {
  id: string;
  version: string;
}

export interface AcousticFillerProvenance {
  source?: AcousticFillerProvenanceSource;
  runtime?: string;
  audioSha256?: string;
  modelSha256?: string;
  sampleRate?: number;
  threshold?: number;
  timingSource?: string;
  scoreMeaning?: string;
  timingNote?: string;
  boundaryStatus?: 'unverified';
  releaseValidated?: boolean;
}

export interface AcousticFillerBenchmark {
  windowCount?: number;
  processingSeconds?: number;
  realTimeFactor?: number;
  host?: string;
}

export interface AcousticFillerEvent {
  id: string;
  startSeconds: number;
  endSeconds: number;
  label: AcousticFillerLabel;
  /** Raw detector score. It is intentionally not called confidence. */
  score: number;
  /** Null means that model boundary error has not been measured. */
  timingUncertaintySeconds: number | null;
  /** Optional source-frame resolution, distinct from measured uncertainty. */
  timingResolutionSeconds?: number;
}

export interface AcousticFillerResult {
  schemaVersion: typeof ACOUSTIC_FILLER_SCHEMA_VERSION;
  status: AcousticFillerStatus;
  sourceId: string;
  analysisRevision: number;
  model: AcousticFillerModel;
  /** The processor that actually performed this analysis. */
  actualProcessor: AcousticFillerProcessor;
  durationSeconds: number;
  events: AcousticFillerEvent[];
  /** Required in practice for unavailable results, optional for old producers. */
  unavailableReason?: string;
  provenance?: AcousticFillerProvenance;
  benchmark?: AcousticFillerBenchmark;
}

export interface AcousticFillerScope {
  sourceId: string;
  analysisRevision: number;
  durationSeconds?: number;
}

export type AcousticFillerAdapterResult =
  | {
    status: 'ready';
    result: AcousticFillerResult;
    marks: CleanupMarkInput[];
  }
  | {
    status: 'unavailable';
    result: AcousticFillerResult;
    marks: [];
    reason: string;
  };

export type AcousticFillerResultErrorCode = 'malformed' | 'stale' | 'identity-mismatch';

export class AcousticFillerResultError extends Error {
  readonly code: AcousticFillerResultErrorCode;
  readonly path: string;

  constructor(code: AcousticFillerResultErrorCode, message: string, path = '') {
    super(message);
    this.name = 'AcousticFillerResultError';
    this.code = code;
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const VALID_LABELS: readonly AcousticFillerLabel[] = ['um', 'uh'];
const VALID_PROCESSORS: readonly AcousticFillerProcessor[] = ['cpu', 'gpu', 'npu', 'unknown'];
const VALID_PROVENANCE_SOURCES: readonly AcousticFillerProvenanceSource[] = ['fixture', 'device', 'host-audio'];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown, path: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw malformed(`${path} must be a non-empty string`, path);
  }
  if (value.length > maxLength) {
    throw malformed(`${path} exceeds the maximum length of ${maxLength}`, path);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) throw malformed(`${path} must be finite`, path);
  return value;
}

function boundedDuration(value: unknown, path: string): number {
  const duration = finiteNumber(value, path);
  if (duration <= 0 || duration > ACOUSTIC_FILLER_MAX_DURATION_SECONDS) {
    throw malformed(`${path} must be greater than zero and no more than ${ACOUSTIC_FILLER_MAX_DURATION_SECONDS} seconds`, path);
  }
  return duration;
}

function malformed(message: string, path: string): never {
  throw new AcousticFillerResultError('malformed', message, path);
}

function validateScope(scope: AcousticFillerScope): AcousticFillerScope {
  if (!isRecord(scope)) malformed('scope must be an object', 'scope');
  const sourceId = nonEmptyString(scope.sourceId, 'scope.sourceId');
  if (!isSafeInteger(scope.analysisRevision) || scope.analysisRevision < 0) {
    malformed('scope.analysisRevision must be a non-negative integer', 'scope.analysisRevision');
  }
  const durationSeconds = scope.durationSeconds === undefined
    ? undefined
    : boundedDuration(scope.durationSeconds, 'scope.durationSeconds');
  return {
    sourceId,
    analysisRevision: scope.analysisRevision,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

function validateModel(value: unknown): AcousticFillerModel {
  if (!isRecord(value)) malformed('model must be an object', 'model');
  return {
    id: nonEmptyString(value.id, 'model.id'),
    version: nonEmptyString(value.version, 'model.version'),
  };
}

function validateProvenance(value: unknown): AcousticFillerProvenance {
  if (!isRecord(value)) malformed('provenance must be an object', 'provenance');
  if (value.source !== undefined && !VALID_PROVENANCE_SOURCES.includes(value.source as AcousticFillerProvenanceSource)) {
    malformed('provenance.source is invalid', 'provenance.source');
  }
  return {
    ...(value.source === undefined ? {} : { source: value.source as AcousticFillerProvenanceSource }),
    ...(value.runtime === undefined ? {} : { runtime: nonEmptyString(value.runtime, 'provenance.runtime') }),
    ...(value.modelSha256 === undefined ? {} : { modelSha256: sha256(value.modelSha256, 'provenance.modelSha256') }),
    ...(value.audioSha256 === undefined ? {} : { audioSha256: sha256(value.audioSha256, 'provenance.audioSha256') }),
    ...(value.sampleRate === undefined ? {} : { sampleRate: boundedPositiveInteger(value.sampleRate, 'provenance.sampleRate', 192_000) }),
    ...(value.threshold === undefined ? {} : { threshold: boundedUnit(value.threshold, 'provenance.threshold') }),
    ...(value.timingSource === undefined ? {} : { timingSource: nonEmptyString(value.timingSource, 'provenance.timingSource', 256) }),
    ...(value.scoreMeaning === undefined ? {} : { scoreMeaning: nonEmptyString(value.scoreMeaning, 'provenance.scoreMeaning', 256) }),
    ...(value.timingNote === undefined ? {} : { timingNote: nonEmptyString(value.timingNote, 'provenance.timingNote', 1_000) }),
    ...(value.boundaryStatus === undefined ? {} : { boundaryStatus: value.boundaryStatus === 'unverified' ? 'unverified' : invalidBoundaryStatus() }),
    ...(value.releaseValidated === undefined ? {} : { releaseValidated: requireBoolean(value.releaseValidated, 'provenance.releaseValidated') }),
  };
}

function sha256(value: unknown, path: string): string {
  const digest = nonEmptyString(value, path, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) malformed(`${path} must be a lowercase SHA-256 digest`, path);
  return digest;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') malformed(`${path} must be boolean`, path);
  return value;
}

function boundedPositiveInteger(value: unknown, path: string, maximum: number): number {
  if (!isSafeInteger(value) || value <= 0 || value > maximum) {
    malformed(`${path} must be a positive integer no more than ${maximum}`, path);
  }
  return value;
}

function boundedUnit(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0 || number > 1) malformed(`${path} must be between zero and one`, path);
  return number;
}

function invalidBoundaryStatus(): never {
  malformed('provenance.boundaryStatus must be unverified', 'provenance.boundaryStatus');
}

function validateBenchmark(value: unknown): AcousticFillerBenchmark {
  if (!isRecord(value)) malformed('benchmark must be an object', 'benchmark');
  const windowCount = value.windowCount === undefined
    ? undefined
    : boundedNonNegativeInteger(value.windowCount, 'benchmark.windowCount', ACOUSTIC_FILLER_MAX_EVENTS);
  const processingSeconds = value.processingSeconds === undefined
    ? undefined
    : boundedNonNegativeNumber(value.processingSeconds, 'benchmark.processingSeconds');
  const realTimeFactor = value.realTimeFactor === undefined
    ? undefined
    : boundedNonNegativeNumber(value.realTimeFactor, 'benchmark.realTimeFactor');
  const host = value.host === undefined ? undefined : nonEmptyString(value.host, 'benchmark.host', 256);
  return {
    ...(windowCount === undefined ? {} : { windowCount }),
    ...(processingSeconds === undefined ? {} : { processingSeconds }),
    ...(realTimeFactor === undefined ? {} : { realTimeFactor }),
    ...(host === undefined ? {} : { host }),
  };
}

function boundedNonNegativeInteger(value: unknown, path: string, maximum: number): number {
  if (!isSafeInteger(value) || value < 0 || value > maximum) {
    malformed(`${path} must be a non-negative integer no more than ${maximum}`, path);
  }
  return value;
}

function boundedNonNegativeNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0) malformed(`${path} must be non-negative`, path);
  return number;
}

function validateEvent(value: unknown, index: number, durationSeconds: number, ids: Set<string>): AcousticFillerEvent {
  const path = `events[${index}]`;
  if (!isRecord(value)) malformed(`${path} must be an object`, path);
  const id = nonEmptyString(value.id, `${path}.id`);
  if (ids.has(id)) malformed(`duplicate acoustic filler event id ${id}`, `${path}.id`);
  ids.add(id);

  const startSeconds = finiteNumber(value.startSeconds, `${path}.startSeconds`);
  const endSeconds = finiteNumber(value.endSeconds, `${path}.endSeconds`);
  if (startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds) {
    malformed(`${path} must be a positive interval within durationSeconds`, path);
  }

  if (!VALID_LABELS.includes(value.label as AcousticFillerLabel)) {
    malformed(`${path}.label must be um or uh`, `${path}.label`);
  }

  const score = finiteNumber(value.score, `${path}.score`);
  if (score < 0 || score > 1) {
    malformed(`${path}.score must be between zero and one`, `${path}.score`);
  }

  const timingUncertaintySeconds = value.timingUncertaintySeconds === null
    ? null
    : finiteNumber(value.timingUncertaintySeconds, `${path}.timingUncertaintySeconds`);
  if (timingUncertaintySeconds !== null && (timingUncertaintySeconds < 0 || timingUncertaintySeconds > durationSeconds)) {
    malformed(`${path}.timingUncertaintySeconds must be within durationSeconds`, `${path}.timingUncertaintySeconds`);
  }
  const timingResolutionSeconds = value.timingResolutionSeconds === undefined
    ? undefined
    : finiteNumber(value.timingResolutionSeconds, `${path}.timingResolutionSeconds`);
  if (timingResolutionSeconds !== undefined && (timingResolutionSeconds <= 0 || timingResolutionSeconds > ACOUSTIC_FILLER_MAX_TIMING_RESOLUTION_SECONDS)) {
    malformed(`${path}.timingResolutionSeconds must be between zero and ${ACOUSTIC_FILLER_MAX_TIMING_RESOLUTION_SECONDS} seconds`, `${path}.timingResolutionSeconds`);
  }

  return {
    id,
    startSeconds,
    endSeconds,
    label: value.label as AcousticFillerLabel,
    score,
    timingUncertaintySeconds,
    ...(timingResolutionSeconds === undefined ? {} : { timingResolutionSeconds }),
  };
}

/**
 * Validate an untrusted detector result and reject stale or foreign identity.
 * The returned object contains only fields in this adapter's published
 * contract, so arbitrary input properties cannot leak into cleanup state.
 */
export function validateAcousticFillerResult(
  input: unknown,
  expectedScope?: AcousticFillerScope,
): AcousticFillerResult {
  if (!isRecord(input)) malformed('acoustic filler result must be an object', 'result');
  if (input.schemaVersion !== ACOUSTIC_FILLER_SCHEMA_VERSION) {
    malformed('unsupported acoustic filler schemaVersion', 'schemaVersion');
  }
  if (input.status !== 'ready' && input.status !== 'unavailable') {
    malformed('acoustic filler status must be ready or unavailable', 'status');
  }

  const sourceId = nonEmptyString(input.sourceId, 'sourceId');
  if (!isSafeInteger(input.analysisRevision) || input.analysisRevision < 0) {
    malformed('analysisRevision must be a non-negative integer', 'analysisRevision');
  }
  const model = validateModel(input.model);
  if (!VALID_PROCESSORS.includes(input.actualProcessor as AcousticFillerProcessor)) {
    malformed('actualProcessor must identify the processor actually used', 'actualProcessor');
  }
  const actualProcessor = input.actualProcessor as AcousticFillerProcessor;
  const durationSeconds = boundedDuration(input.durationSeconds, 'durationSeconds');
  if (!Array.isArray(input.events)) malformed('events must be an array', 'events');
  if (input.events.length > ACOUSTIC_FILLER_MAX_EVENTS) {
    malformed(`events cannot contain more than ${ACOUSTIC_FILLER_MAX_EVENTS} entries`, 'events');
  }
  if (input.status === 'unavailable' && input.events.length !== 0) {
    malformed('unavailable acoustic filler results must contain zero events', 'events');
  }

  const ids = new Set<string>();
  const events = input.events.map((event, index) => validateEvent(event, index, durationSeconds, ids));
  const unavailableReason = input.unavailableReason === undefined
    ? undefined
    : nonEmptyString(input.unavailableReason, 'unavailableReason', 1_000);
  if (input.status === 'ready' && unavailableReason !== undefined) {
    malformed('ready acoustic filler results cannot carry unavailableReason', 'unavailableReason');
  }
  const provenance = input.provenance === undefined ? undefined : validateProvenance(input.provenance);
  const benchmark = input.benchmark === undefined ? undefined : validateBenchmark(input.benchmark);

  const result: AcousticFillerResult = {
    schemaVersion: ACOUSTIC_FILLER_SCHEMA_VERSION,
    status: input.status,
    sourceId,
    analysisRevision: input.analysisRevision,
    model,
    actualProcessor,
    durationSeconds,
    events,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(benchmark === undefined ? {} : { benchmark }),
  };

  if (expectedScope !== undefined) {
    const scope = validateScope(expectedScope);
    if (sourceId !== scope.sourceId) {
      throw new AcousticFillerResultError(
        'identity-mismatch',
        `Acoustic filler result sourceId ${sourceId} does not match expected sourceId ${scope.sourceId}.`,
        'sourceId',
      );
    }
    if (input.analysisRevision !== scope.analysisRevision) {
      throw new AcousticFillerResultError(
        'stale',
        `Acoustic filler result analysisRevision ${input.analysisRevision} is stale for expected revision ${scope.analysisRevision}.`,
        'analysisRevision',
      );
    }
    if (scope.durationSeconds !== undefined && durationSeconds !== scope.durationSeconds) {
      throw new AcousticFillerResultError(
        'stale',
        `Acoustic filler result durationSeconds ${durationSeconds} does not match the current source duration ${scope.durationSeconds}.`,
        'durationSeconds',
      );
    }
  }

  return result;
}

function mapValidatedResultToCleanupMarks(result: AcousticFillerResult): CleanupMarkInput[] {
  if (result.status === 'unavailable') return [];
  return result.events.map((event) => ({
    id: event.id,
    recordingId: result.sourceId,
    kind: 'filler' as const,
    text: event.label,
    t0: event.startSeconds,
    t1: event.endSeconds,
    // Acoustic detection cannot prove a safe splice or sentence placement.
    safeBoundary: false,
    boundarySource: 'unknown' as const,
    startBoundary: { source: 'unknown' as const, verified: false },
    endBoundary: { source: 'unknown' as const, verified: false },
  }));
}

/**
 * Map a validated (or untrusted, which is validated here) result into the
 * existing cleanup mark input.  An unavailable model returns no marks; a
 * ready result with zero events also returns no marks, but callers can inspect
 * the result status to keep those cases distinct.
 */
export function acousticFillerResultToCleanupMarks(
  input: unknown,
  expectedScope?: AcousticFillerScope,
): CleanupMarkInput[] {
  return mapValidatedResultToCleanupMarks(validateAcousticFillerResult(input, expectedScope));
}

/**
 * Adapt the detector result while preserving the unavailable-versus-empty
 * distinction for review consumers.
 */
export function adaptAcousticFillerResult(
  input: unknown,
  expectedScope?: AcousticFillerScope,
): AcousticFillerAdapterResult {
  const result = validateAcousticFillerResult(input, expectedScope);
  if (result.status === 'unavailable') {
    return {
      status: 'unavailable',
      result,
      marks: [],
      reason: result.unavailableReason ?? 'The acoustic filler model is unavailable.',
    };
  }
  return {
    status: 'ready',
    result,
    marks: mapValidatedResultToCleanupMarks(result),
  };
}
