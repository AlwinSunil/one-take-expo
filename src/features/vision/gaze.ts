import {
  VISION_STALE_FRAME_MS,
  type VisionEvidence,
  type VisionLensFacing,
  type VisionProcessor,
} from './state.ts';

/** The requested cadence is intentionally approximate; it is not a sensor rate promise. */
export const GAZE_SAMPLE_INTERVAL_MS = 1_000 as const;
/** Keep metadata bounded even when a recording is left open for a long time. */
export const GAZE_MAX_OBSERVATIONS = 120 as const;
/** Avoid unbounded work when one callback arrives after a very long interruption. */
export const GAZE_MAX_GAPS_PER_SAMPLE = 120 as const;
export const GAZE_COORDINATE_SPACE = 'upright-unmirrored' as const;
export const GAZE_MODEL_VERSION = '16.1.7' as const;

export type GazeLabel = 'camera' | 'left' | 'right' | 'up' | 'down' | 'away' | 'unknown';

export type GazeObservationReason =
  | 'no-face'
  | 'multiple-faces'
  | 'unsupported-gaze-engine'
  | 'stale'
  | 'unavailable'
  | 'sampling-gap';

export type GazeProvenanceSource = 'device' | 'fixture';

/**
 * Identity that must travel with every observation.
 *
 * `visionSessionId` identifies the current native analyzer binding. It is
 * separate from `captureSessionId`, which is the persisted recording identity
 * and remains stable for the lifetime of one recording attempt.
 */
export type GazeCaptureScope = Readonly<{
  projectId: string;
  sourceId: string;
  takeId: string;
  captureSessionId: string;
  visionSessionId?: string;
  generation: string | number;
  lensFacing: VisionLensFacing;
  /** The display transform only; coordinates remain upright and unmirrored. */
  previewMirrored: boolean;
  provenanceSource?: GazeProvenanceSource;
}>;

export type GazeProvenance = Readonly<{
  source: GazeProvenanceSource;
  model: string;
  modelVersion: string;
  /** The processor actually reported by the frame owner. */
  processor: VisionProcessor;
  coordinateSpace: typeof GAZE_COORDINATE_SPACE;
  previewMirrored: boolean;
  clock: 'js-monotonic';
  clockAnchor: 'record-request';
  /** This collector does not calibrate JS time to encoded media PTS. */
  calibratedToMediaPts: false;
  /** Camera bridge latency is not measured by the existing frame owner. */
  bridgeLatency: 'unknown';
  sourceZeroMonotonicMs: number;
}>;

export type GazeObservation = Readonly<{
  id: string;
  scope: GazeCaptureScope;
  relativeSeconds: number;
  label: GazeLabel;
  reason: GazeObservationReason;
  confidence: number | null;
  /** Null means the current frame owner has not supplied a calibrated bound. */
  uncertaintySeconds: number | null;
  provenance: GazeProvenance;
}>;

export type GazeGapSummary = Readonly<{
  count: number;
  startRelativeSeconds: number;
  endRelativeSeconds: number;
}>;

export type GazeCollectorSnapshot = Readonly<{
  scope: GazeCaptureScope;
  startMonotonicMs: number;
  stopped: boolean;
  stoppedAtMonotonicMs: number | null;
  /** Recent diagnostics only; use the sink for a complete durable stream. */
  observations: readonly GazeObservation[];
  /** Number of accepted cadence slots that emitted an observation. */
  acceptedSampleCount: number;
  /** Evidence rejected because its analyzer identity did not match the scope. */
  rejectedEvidenceCount: number;
  /** All generated cadence gaps, including gaps later evicted by retention. */
  samplingGapCount: number;
  /** Timestamp range for cadence gaps omitted from the bounded per-callback replay. */
  samplingGapOverflowSummary: GazeGapSummary | null;
  droppedObservationCount: number;
  retentionGapSummary: GazeGapSummary | null;
  sinkFailureCount: number;
}>;

export type GazeObservationSink = (observation: GazeObservation) => void;

export type GazeCollectorOptions = Readonly<{
  /** Called synchronously for every emitted observation, including evicted gaps. */
  onObservation?: GazeObservationSink;
}>;

export type GazeCollector = Readonly<{
  /** Returns the newly accepted observation, or null for throttled/rejected input. */
  sample: (nowMs: number, evidence: VisionEvidence) => GazeObservation | null;
  /** Stops collection and records any cadence gaps already known at stop time. */
  stop: (nowMs: number) => GazeCollectorSnapshot;
  snapshot: () => GazeCollectorSnapshot;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidLensFacing(value: unknown): value is VisionLensFacing {
  return value === 'front' || value === 'back';
}

function isValidGeneration(value: unknown): value is string | number {
  return isNonEmptyString(value)
    || (isFiniteNumber(value) && Number.isFinite(value));
}

function normalizeScope(value: GazeCaptureScope): GazeCaptureScope {
  if (!isRecord(value)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.sourceId)
    || !isNonEmptyString(value.takeId)
    || !isNonEmptyString(value.captureSessionId)
    || (value.visionSessionId !== undefined && !isNonEmptyString(value.visionSessionId))
    || !isValidGeneration(value.generation)
    || !isValidLensFacing(value.lensFacing)
    || typeof value.previewMirrored !== 'boolean'
    || (value.provenanceSource !== undefined
      && value.provenanceSource !== 'device'
      && value.provenanceSource !== 'fixture')) {
    throw new TypeError('A gaze scope requires stable project, source, take, capture, generation and lens identity.');
  }

  return Object.freeze({
    projectId: value.projectId,
    sourceId: value.sourceId,
    takeId: value.takeId,
    captureSessionId: value.captureSessionId,
    ...(value.visionSessionId === undefined ? {} : { visionSessionId: value.visionSessionId }),
    generation: value.generation,
    lensFacing: value.lensFacing,
    previewMirrored: value.previewMirrored,
    ...(value.provenanceSource === undefined ? {} : { provenanceSource: value.provenanceSource }),
  });
}

function cloneScope(scope: GazeCaptureScope): GazeCaptureScope {
  return Object.freeze({ ...scope });
}

function evidenceSessionId(scope: GazeCaptureScope): string {
  return scope.visionSessionId ?? scope.captureSessionId;
}

function isIdentityMatch(scope: GazeCaptureScope, evidence: VisionEvidence): boolean {
  return evidence.sessionId === evidenceSessionId(scope)
    && evidence.lensFacing === scope.lensFacing;
}

function modelForEvidence(evidence: VisionEvidence | null): string {
  return evidence?.engine === 'mlkit-face' ? 'mlkit-face' : evidence?.engine ?? 'unknown';
}

function modelVersionForEvidence(evidence: VisionEvidence | null): string {
  return evidence?.engine === 'mlkit-face' ? GAZE_MODEL_VERSION : 'unknown';
}

function processorForEvidence(evidence: VisionEvidence | null): VisionProcessor {
  return evidence?.processor ?? 'unknown';
}

function createProvenance(
  scope: GazeCaptureScope,
  startMonotonicMs: number,
  evidence: VisionEvidence | null,
): GazeProvenance {
  return Object.freeze({
    source: scope.provenanceSource ?? 'device',
    model: modelForEvidence(evidence),
    modelVersion: modelVersionForEvidence(evidence),
    processor: processorForEvidence(evidence),
    coordinateSpace: GAZE_COORDINATE_SPACE,
    previewMirrored: scope.previewMirrored,
    clock: 'js-monotonic',
    clockAnchor: 'record-request',
    calibratedToMediaPts: false,
    bridgeLatency: 'unknown',
    sourceZeroMonotonicMs: startMonotonicMs,
  });
}

function relativeSeconds(startMonotonicMs: number, timestampMs: number): number {
  return Math.max(0, (timestampMs - startMonotonicMs) / 1_000);
}

function frameTimestamp(nowMs: number, evidence: VisionEvidence): number {
  if (evidence.status === 'ready'
    && isFiniteNumber(evidence.frameCapturedAtMs)
    && evidence.frameCapturedAtMs >= nowMs - 60_000
    && evidence.frameCapturedAtMs <= nowMs) {
    return evidence.frameCapturedAtMs;
  }
  return nowMs;
}

function classifyEvidence(
  nowMs: number,
  startMonotonicMs: number,
  evidence: VisionEvidence,
): GazeObservationReason {
  if (evidence.status !== 'ready') {
    return evidence.reason === 'stale-frame' ? 'stale' : 'unavailable';
  }

  const ageMs = nowMs - evidence.frameCapturedAtMs;
  if (!Number.isFinite(ageMs)
    || evidence.frameCapturedAtMs < startMonotonicMs
    || ageMs < 0
    || ageMs > VISION_STALE_FRAME_MS) return 'stale';
  if (evidence.engine !== 'mlkit-face') return 'unsupported-gaze-engine';
  const faces = Array.isArray(evidence.faces) ? evidence.faces : [];
  if (faces.length > 1) return 'multiple-faces';
  if (evidence.facePresence === 'absent' || faces.length === 0) return 'no-face';

  // ML Kit's face-only detector cannot distinguish camera, left, right, up,
  // down or away. A detected face is therefore still explicitly unknown.
  return 'unsupported-gaze-engine';
}

function identityToken(scope: GazeCaptureScope): string {
  return `${scope.captureSessionId}:${String(scope.generation)}`;
}

function finiteNow(value: number, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function makeSnapshot(
  scope: GazeCaptureScope,
  startMonotonicMs: number,
  stopped: boolean,
  stoppedAtMonotonicMs: number | null,
  observations: readonly GazeObservation[],
  acceptedSampleCount: number,
  rejectedEvidenceCount: number,
  samplingGapCount: number,
  samplingGapOverflowSummary: GazeGapSummary | null,
  droppedObservationCount: number,
  retentionGapSummary: GazeGapSummary | null,
  sinkFailureCount: number,
): GazeCollectorSnapshot {
  return Object.freeze({
    scope: cloneScope(scope),
    startMonotonicMs,
    stopped,
    stoppedAtMonotonicMs,
    observations: Object.freeze([...observations]),
    acceptedSampleCount,
    rejectedEvidenceCount,
    samplingGapCount,
    samplingGapOverflowSummary: samplingGapOverflowSummary === null
      ? null
      : Object.freeze({ ...samplingGapOverflowSummary }),
    droppedObservationCount,
    retentionGapSummary: retentionGapSummary === null
      ? null
      : Object.freeze({ ...retentionGapSummary }),
    sinkFailureCount,
  });
}

/**
 * Creates a pure, source-scoped collector over the existing vision evidence.
 *
 * Sampling never infers gaze from face presence or head pose. Until a
 * calibrated gaze engine exists, supported face evidence remains unknown with
 * an explicit unsupported reason. The collector has no camera, timer, native
 * module or persistence side effect; its owner calls `sample` while recording
 * and `stop` on stop/background/route exit.
 */
export function createGazeCollector(
  inputScope: GazeCaptureScope,
  startMonotonicMs: number,
  options?: GazeCollectorOptions | GazeObservationSink,
): GazeCollector {
  if (!isFiniteNumber(startMonotonicMs)) {
    throw new TypeError('Gaze collection requires a finite JS monotonic start time.');
  }

  const scope = normalizeScope(inputScope);
  const onObservation: GazeObservationSink | undefined = typeof options === 'function'
    ? options
    : options?.onObservation;
  const observations: GazeObservation[] = [];
  let stopped = false;
  let stoppedAtMonotonicMs: number | null = null;
  let lastSampleMonotonicMs: number | null = null;
  let acceptedSampleCount = 0;
  let rejectedEvidenceCount = 0;
  let samplingGapCount = 0;
  let samplingGapOverflowSummary: GazeGapSummary | null = null;
  let droppedObservationCount = 0;
  let sinkFailureCount = 0;
  let retentionGapSummary: GazeGapSummary | null = null;
  let nextObservationNumber = 1;
  let lastProvenance = createProvenance(scope, startMonotonicMs, null);

  function addRetentionDrop(observation: GazeObservation): void {
    droppedObservationCount += 1;
    const relative = observation.relativeSeconds;
    if (retentionGapSummary === null) {
      retentionGapSummary = {
        count: 1,
        startRelativeSeconds: relative,
        endRelativeSeconds: relative,
      };
      return;
    }
    retentionGapSummary = {
      count: retentionGapSummary.count + 1,
      startRelativeSeconds: Math.min(retentionGapSummary.startRelativeSeconds, relative),
      endRelativeSeconds: Math.max(retentionGapSummary.endRelativeSeconds, relative),
    };
  }

  function appendObservation(
    timestampMs: number,
    label: GazeLabel,
    reason: GazeObservationReason,
    provenance: GazeProvenance,
  ): GazeObservation {
    const observation: GazeObservation = Object.freeze({
      id: `${identityToken(scope)}:gaze-${nextObservationNumber}`,
      scope: cloneScope(scope),
      relativeSeconds: relativeSeconds(startMonotonicMs, timestampMs),
      label,
      reason,
      confidence: null,
      uncertaintySeconds: null,
      provenance: Object.freeze({ ...provenance }),
    });
    nextObservationNumber += 1;
    observations.push(observation);
    try {
      onObservation?.(observation);
    } catch {
      // A metadata sink must never stop capture or cadence collection.
      sinkFailureCount += 1;
    }
    if (observations.length > GAZE_MAX_OBSERVATIONS) {
      const dropped = observations.shift();
      if (dropped) addRetentionDrop(dropped);
    }
    return observation;
  }

  function appendGap(timestampMs: number): GazeObservation {
    samplingGapCount += 1;
    return appendObservation(timestampMs, 'unknown', 'sampling-gap', lastProvenance);
  }

  function appendGaps(fromMs: number, toMs: number, includeTrailingSlot = false): void {
    if (!isFiniteNumber(fromMs) || !isFiniteNumber(toMs) || toMs <= fromMs) return;
    const elapsedMs = toMs - fromMs;
    // A sample that arrives just after its one-second slot fills that slot.
    // Only a complete intervening slot becomes an explicit gap. Stop has no
    // replacement sample, so it includes the trailing slot at its boundary.
    const missingCount = Math.max(
      0,
      Math.floor(elapsedMs / GAZE_SAMPLE_INTERVAL_MS) - (includeTrailingSlot ? 0 : 1),
    );
    if (missingCount === 0) return;

    const emittedCount = Math.min(missingCount, GAZE_MAX_GAPS_PER_SAMPLE);
    const firstEmittedIndex = missingCount - emittedCount + 1;
    for (let index = firstEmittedIndex; index <= missingCount; index += 1) {
      appendGap(fromMs + index * GAZE_SAMPLE_INTERVAL_MS);
    }

    // A very long background interruption can have more missed slots than the
    // bounded replay can retain. Keep the count and omitted timestamp range for
    // diagnostics while retaining the most recent explicit gap timestamps.
    if (missingCount > emittedCount) {
      const omittedCount = missingCount - emittedCount;
      samplingGapCount += omittedCount;
      const omittedSummary: GazeGapSummary = {
        count: omittedCount,
        startRelativeSeconds: relativeSeconds(
          startMonotonicMs,
          fromMs + GAZE_SAMPLE_INTERVAL_MS,
        ),
        endRelativeSeconds: relativeSeconds(
          startMonotonicMs,
          fromMs + omittedCount * GAZE_SAMPLE_INTERVAL_MS,
        ),
      };
      if (samplingGapOverflowSummary === null) samplingGapOverflowSummary = omittedSummary;
      else {
        samplingGapOverflowSummary = {
          count: samplingGapOverflowSummary.count + omittedSummary.count,
          startRelativeSeconds: Math.min(
            samplingGapOverflowSummary.startRelativeSeconds,
            omittedSummary.startRelativeSeconds,
          ),
          endRelativeSeconds: Math.max(
            samplingGapOverflowSummary.endRelativeSeconds,
            omittedSummary.endRelativeSeconds,
          ),
        };
      }
    }
  }

  function sample(nowMs: number, evidence: VisionEvidence): GazeObservation | null {
    if (stopped) return null;
    if (!isFiniteNumber(nowMs) || nowMs < startMonotonicMs) return null;
    if (!isRecord(evidence) || !isIdentityMatch(scope, evidence)) {
      rejectedEvidenceCount += 1;
      return null;
    }

    if (lastSampleMonotonicMs !== null) {
      const elapsedMs = nowMs - lastSampleMonotonicMs;
      if (elapsedMs < GAZE_SAMPLE_INTERVAL_MS) return null;
    }

    const currentProvenance = createProvenance(scope, startMonotonicMs, evidence);
    lastProvenance = currentProvenance;
    if (lastSampleMonotonicMs !== null) appendGaps(lastSampleMonotonicMs, nowMs);
    else appendGaps(startMonotonicMs, nowMs);

    const reason = classifyEvidence(nowMs, startMonotonicMs, evidence);
    const timestampMs = reason === 'stale' || evidence.status !== 'ready'
      ? nowMs
      : frameTimestamp(nowMs, evidence);
    const observation = appendObservation(timestampMs, 'unknown', reason, currentProvenance);
    lastSampleMonotonicMs = nowMs;
    acceptedSampleCount += 1;
    return observation;
  }

  function stop(nowMs: number): GazeCollectorSnapshot {
    if (stopped) return snapshot();
    const stopMs = Math.max(startMonotonicMs, finiteNow(nowMs, startMonotonicMs));
    if (lastSampleMonotonicMs === null) appendGaps(startMonotonicMs, stopMs, true);
    else appendGaps(lastSampleMonotonicMs, stopMs, true);
    stopped = true;
    stoppedAtMonotonicMs = stopMs;
    return snapshot();
  }

  function snapshot(): GazeCollectorSnapshot {
    return makeSnapshot(
      scope,
      startMonotonicMs,
      stopped,
      stoppedAtMonotonicMs,
      observations,
      acceptedSampleCount,
      rejectedEvidenceCount,
      samplingGapCount,
      samplingGapOverflowSummary,
      droppedObservationCount,
      retentionGapSummary,
      sinkFailureCount,
    );
  }

  return Object.freeze({ sample, stop, snapshot });
}
