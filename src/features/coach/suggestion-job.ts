import {
  COACH_THRESHOLDS,
  chooseCoachView,
} from './policy.ts';
import type {
  CoachIntent,
  CoachVisionEvidence,
  MeasuredCueObservation,
} from './policy.ts';

/**
 * Visual Suggestions are a bounded, user-requested job.
 *
 * The controller deliberately has no constructor side effects and does not
 * watch camera frames.  A camera owner binds the current capture identity and
 * calls `start` only after the creator taps the Visual Suggestions action.
 */

export const SUGGESTION_JOB_DEFAULT_TIMEOUT_MS = 2_500;
export const SUGGESTION_JOB_MAX_EVALUATIONS = 1;

export type SuggestionJobStatus =
  | 'idle'
  | 'loading'
  | 'result'
  | 'all-good'
  | 'unavailable'
  | 'cancelled'
  | 'stale';

export type SuggestionCategory =
  | 'framing'
  | 'face-position'
  | 'subject-position'
  | 'lighting'
  | 'camera-angle'
  | 'exposure'
  | 'background';

export type SuggestionCue =
  | 'face-clipping'
  | 'subject-clipping'
  | 'backlight'
  | 'background-distraction';

export type SuggestionUnavailableReason =
  | 'invalid-request'
  | 'vision-unavailable'
  | 'stale-frame'
  | 'uncalibrated-evidence'
  | 'unsupported-category'
  | 'timeout'
  | 'evaluator-error'
  | 'cancelled'
  | 'stale-request';

export type SuggestionCancelReason =
  | 'dismissed'
  | 'navigation'
  | 'stop'
  | 'background'
  | 'route-exit'
  | 'replaced'
  | 'manual';

export interface SuggestionJobIdentity {
  /** Stable capture-session identity. */
  sessionId: string;
  /** Changes for every camera/lens binding generation, including a return to the same lens. */
  lensGeneration: string;
  /** Advice is tied to the selected framing intent. */
  intent: CoachIntent;
}

export interface SuggestionJobRequest extends SuggestionJobIdentity {
  /** Monotonic clock value captured when the explicit request was made. */
  requestedAtMs: number;
  /** Latest observation owned by the shared camera/vision path. */
  evidence?: CoachVisionEvidence;
}

export interface SuggestionJobStart {
  jobId: string;
  request: SuggestionJobRequest;
}

export interface SuggestionEvidence {
  source: 'on-device-vision' | 'fixture' | 'none';
  calibrated: boolean;
  detectorId?: string;
  detectorVersion?: string;
  processor?: 'cpu' | 'gpu' | 'npu' | 'unknown';
  observedAtMs?: number;
}

export type SuggestionEvaluation =
  | {
      kind: 'actionable';
      cue: SuggestionCue;
      category: SuggestionCategory;
      title: string;
      message: string;
      reason: string;
      evidence: SuggestionEvidence;
      unsupportedCategories?: readonly SuggestionCategory[];
    }
  | {
      kind: 'all-good';
      message: string;
      evidence: SuggestionEvidence;
      unsupportedCategories?: readonly SuggestionCategory[];
    }
  | {
      kind: 'intentional';
      message: string;
      evidence: SuggestionEvidence;
    }
  | {
      kind: 'unavailable';
      reason: SuggestionUnavailableReason;
      message: string;
      unsupportedCategories: readonly SuggestionCategory[];
    };

export interface SuggestionEvaluationContext {
  signal: AbortSignal;
  jobId: string;
  /** Evaluators must not perform more than this many bounded passes. */
  maxEvaluations: 1;
}

export type SuggestionEvaluator = (
  request: SuggestionJobRequest,
  context: SuggestionEvaluationContext,
) => SuggestionEvaluation | Promise<SuggestionEvaluation>;

export interface SuggestionJobDiagnostics {
  starts: number;
  evaluations: number;
  completed: number;
  cancellations: number;
  staleResults: number;
  timeouts: number;
  errors: number;
}

export interface SuggestionJobSnapshot {
  status: SuggestionJobStatus;
  jobId: string | null;
  request: SuggestionJobRequest | null;
  evaluation?: SuggestionEvaluation;
  reason?: SuggestionCancelReason | 'camera-changed' | 'lens-changed' | 'session-ended' | 'stale-request';
  startedAtMs?: number;
  finishedAtMs?: number;
  attempt: number;
}

export interface SuggestionJobController {
  /** Bind a current session/lens/intent without starting a job. */
  bind(identity: SuggestionJobIdentity): SuggestionJobSnapshot;
  /** Start only for an explicit creator request. Identical loading requests deduplicate. */
  start(request: SuggestionJobRequest): SuggestionJobSnapshot;
  /** Retry with a fresh camera snapshot; omitted evidence stays unavailable. */
  retry(evidence?: CoachVisionEvidence): SuggestionJobSnapshot;
  /** Cancel active work and prevent a late evaluator result from becoming visible. */
  cancel(reason?: SuggestionCancelReason): SuggestionJobSnapshot;
  /** Invalidate the old result when the camera/session identity changes. */
  invalidate(identity: SuggestionJobIdentity, reason?: 'camera-changed' | 'lens-changed' | 'session-ended'): SuggestionJobSnapshot;
  getSnapshot(): SuggestionJobSnapshot;
  getDiagnostics(): SuggestionJobDiagnostics;
  subscribe(listener: (snapshot: SuggestionJobSnapshot) => void): () => void;
  /** Await the currently running evaluator, timeout, cancellation or stale transition. */
  whenSettled(): Promise<SuggestionJobSnapshot>;
}

export interface SuggestionJobControllerOptions {
  evaluator?: SuggestionEvaluator;
  timeoutMs?: number;
  now?: () => number;
}

interface ActiveJob {
  jobId: string;
  request: SuggestionJobRequest;
  controller: AbortController;
  attempt: number;
  resolveSettled: (snapshot: SuggestionJobSnapshot) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

let globalSuggestionSequence = 0;
const SKIPPED_EVALUATION = Symbol('suggestion evaluation skipped');

const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  framing: 'framing',
  'face-position': 'face position',
  'subject-position': 'subject position',
  lighting: 'lighting',
  'camera-angle': 'camera angle',
  exposure: 'exposure',
  background: 'background',
};

const TALKING_HEAD_CUES: readonly { cue: SuggestionCue; category: SuggestionCategory }[] = [
  { cue: 'face-clipping', category: 'framing' },
  { cue: 'backlight', category: 'lighting' },
  { cue: 'background-distraction', category: 'background' },
];

const SUBJECT_CUES: readonly { cue: SuggestionCue; category: SuggestionCategory }[] = [
  { cue: 'subject-clipping', category: 'subject-position' },
  { cue: 'backlight', category: 'lighting' },
  { cue: 'background-distraction', category: 'background' },
];

const DEFAULT_UNSUPPORTED_CATEGORIES: readonly SuggestionCategory[] = [
  'framing',
  'face-position',
  'subject-position',
  'lighting',
  'camera-angle',
  'exposure',
  'background',
];

const cueCopy: Record<SuggestionCue, {
  category: SuggestionCategory;
  title: string;
  message: string;
  reason: string;
}> = {
  'face-clipping': {
    category: 'framing',
    title: 'Framing',
    message: 'Give your face a little more room.',
    reason: 'The calibrated face boundary is touching the source frame edge.',
  },
  'subject-clipping': {
    category: 'subject-position',
    title: 'Subject position',
    message: 'Bring the selected subject fully into view.',
    reason: 'The calibrated subject boundary is touching the source frame edge.',
  },
  backlight: {
    category: 'lighting',
    title: 'Lighting',
    message: 'Try turning the selected subject toward the light.',
    reason: 'The calibrated lighting observation found insufficient subject detail.',
  },
  'background-distraction': {
    category: 'background',
    title: 'Background',
    message: 'Check what competes with the selected subject.',
    reason: 'The calibrated background observation found a competing shape.',
  },
};

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function jobIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIdentity(value: SuggestionJobIdentity): boolean {
  return isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.lensGeneration)
    && ['talking-head', 'product', 'subject', 'intentional-look'].includes(value.intent);
}

function sameIdentity(a: SuggestionJobIdentity | null, b: SuggestionJobIdentity | null): boolean {
  return !!a && !!b
    && a.sessionId === b.sessionId
    && a.lensGeneration === b.lensGeneration
    && a.intent === b.intent;
}

function validRequest(request: SuggestionJobRequest): boolean {
  return isIdentity(request)
    && isFiniteNonNegative(request.requestedAtMs);
}

function unavailable(
  reason: SuggestionUnavailableReason,
  message: string,
  unsupportedCategories: readonly SuggestionCategory[] = DEFAULT_UNSUPPORTED_CATEGORIES,
): SuggestionEvaluation {
  return {
    kind: 'unavailable',
    reason,
    message,
    unsupportedCategories,
  };
}

function copyDiagnostics(diagnostics: SuggestionJobDiagnostics): SuggestionJobDiagnostics {
  return { ...diagnostics };
}

function uniqueCategories(categories: readonly SuggestionCategory[]): SuggestionCategory[] {
  return [...new Set(categories)];
}

function categoryList(categories: readonly SuggestionCategory[]): string {
  return categories.map(category => CATEGORY_LABELS[category]).join(', ');
}

function measurementEvidence(observation: MeasuredCueObservation, observedAtMs: number): SuggestionEvidence {
  return {
    source: observation.measurement.source,
    calibrated: observation.measurement.calibrated,
    detectorId: observation.measurement.detectorId,
    detectorVersion: observation.measurement.detectorVersion,
    observedAtMs,
  };
}

function isMeasuredObservation(
  cue: SuggestionCue,
  observation: unknown,
  intent: CoachIntent,
): observation is MeasuredCueObservation {
  if (!observation || typeof observation !== 'object') return false;
  const value = observation as Partial<MeasuredCueObservation>;
  const measurement = value.measurement;
  if (!measurement || typeof measurement !== 'object') return false;
  const candidate = measurement as Partial<MeasuredCueObservation['measurement']>;
  const expectedTarget = intent === 'talking-head'
    ? 'selected-face'
    : intent === 'product'
      ? 'selected-product'
      : 'selected-subject';
  const confidenceValid = cue === 'face-clipping'
    ? typeof candidate.confidence === 'number'
      && Number.isFinite(candidate.confidence)
      && candidate.confidence >= COACH_THRESHOLDS.faceConfidenceFloor
      && candidate.confidence <= 1
    : true;
  const stableWindow = value.state === 'issue'
    ? COACH_THRESHOLDS.issueStableMs
    : COACH_THRESHOLDS.clearStableMs;
  return (value.state === 'issue' || value.state === 'clear')
    && candidate.source === 'on-device-vision'
    && candidate.calibrated === true
    && candidate.target === expectedTarget
    && isNonEmptyString(candidate.detectorId)
    && isNonEmptyString(candidate.detectorVersion)
    && isFiniteNonNegative(value.stableForMs)
    && value.stableForMs >= stableWindow
    && confidenceValid;
}

function intentCues(intent: CoachIntent): readonly { cue: SuggestionCue; category: SuggestionCategory }[] {
  if (intent === 'product' || intent === 'subject') return SUBJECT_CUES;
  return TALKING_HEAD_CUES;
}

function evaluateReadyEvidence(
  request: SuggestionJobRequest,
  evidence: Extract<CoachVisionEvidence, { status: 'ready' }>,
): SuggestionEvaluation {
  const cues = intentCues(request.intent);
  const unsupported: SuggestionCategory[] = [];
  const observations = evidence.observations ?? {};
  let firstIssue: { cue: SuggestionCue; observation: MeasuredCueObservation } | null = null;
  let clearCount = 0;

  // Keep the request-driven evaluator on the same calibrated cue policy as
  // the legacy coach. This call is pure; it does not start frame work.
  const policyDecision = chooseCoachView({
    enabled: true,
    intent: request.intent,
    recording: false,
    speechState: 'silent',
    betweenLines: false,
    nowMs: request.requestedAtMs,
    lastPromptAtMs: null,
    activeCue: null,
    dismissed: [],
    evidence,
  });

  for (const { cue, category } of cues) {
    const observation = observations[cue];
    if (!isMeasuredObservation(cue, observation, request.intent)) {
      unsupported.push(category);
      continue;
    }
    if (observation.state === 'issue' && firstIssue === null) {
      firstIssue = { cue, observation };
    }
    if (observation.state === 'clear') clearCount += 1;
  }

  const unsupportedCategories = uniqueCategories([
    ...unsupported,
    'camera-angle',
    'exposure',
  ]);
  if (firstIssue && policyDecision.kind === 'prompt') {
    const copy = cueCopy[firstIssue.cue];
    return {
      kind: 'actionable',
      cue: firstIssue.cue,
      category: copy.category,
      title: copy.title,
      message: copy.message,
      reason: copy.reason,
      evidence: measurementEvidence(firstIssue.observation, evidence.frameCapturedAtMs),
      ...(unsupportedCategories.length ? { unsupportedCategories } : {}),
    };
  }

  if (unsupported.length || clearCount !== cues.length || policyDecision.kind !== 'all-good') {
    const categories = uniqueCategories([
      ...unsupported,
      'camera-angle',
      'exposure',
    ]);
    return unavailable(
      'uncalibrated-evidence',
      `Face presence alone cannot verify composition. Unverified categories: ${categoryList(categories)}.`,
      categories,
    );
  }

  const first = observations[cues[0]!.cue];
  const firstEvidence = isMeasuredObservation(cues[0]!.cue, first, request.intent)
    ? measurementEvidence(first, evidence.frameCapturedAtMs)
    : { source: 'on-device-vision' as const, calibrated: true };
  return {
    kind: 'all-good',
    message: 'The measured framing and subject cues look clear.',
    evidence: firstEvidence,
    unsupportedCategories: unsupportedCategories.length ? unsupportedCategories : undefined,
  };
}

/**
 * Conservative default evaluator for the current face-only producer.
 *
 * Face presence and head pose do not establish any of the requested visual
 * categories.  The evaluator only returns advice or all-good when every cue
 * it needs is explicitly calibrated by the shared producer.  Fixture callers
 * may inject an evaluator in tests; fixtures never become camera evidence.
 */
export function evaluateSuggestionRequest(request: SuggestionJobRequest): SuggestionEvaluation {
  if (!validRequest(request)) {
    return unavailable('invalid-request', 'Visual Suggestions could not validate this camera request.');
  }

  if (request.intent === 'intentional-look') {
    return {
      kind: 'intentional',
      message: 'Intentional framing selected. Automatic suggestions are off.',
      evidence: { source: 'none', calibrated: false },
    };
  }

  if (!request.evidence) {
    return unavailable(
      'vision-unavailable',
      'Visual Suggestions are unavailable until a current camera signal is ready.',
    );
  }

  if (request.evidence.status === 'pending') {
    return unavailable(
      'vision-unavailable',
      'Visual Suggestions are still waiting for a current camera signal.',
    );
  }

  if (request.evidence.status === 'unavailable') {
    return unavailable(
      request.evidence.reason === 'stale-frame' ? 'stale-frame' : 'vision-unavailable',
      'Visual Suggestions are unavailable until the camera signal is current.',
    );
  }

  const ageMs = request.requestedAtMs - request.evidence.frameCapturedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 500) {
    return unavailable(
      'stale-frame',
      'Visual Suggestions are paused until the camera signal is fresh.',
    );
  }

  return evaluateReadyEvidence(request, request.evidence);
}

function validEvaluationEvidence(value: unknown): value is SuggestionEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<SuggestionEvidence>;
  if (evidence.source === 'none') return evidence.calibrated === false;
  return (evidence.source === 'fixture' || evidence.source === 'on-device-vision')
    && evidence.calibrated === true
    && isNonEmptyString(evidence.detectorId) && isNonEmptyString(evidence.detectorVersion);
}

function validCategories(value: unknown): boolean {
  return value === undefined || (Array.isArray(value)
    && value.every(category => typeof category === 'string' && Object.hasOwn(CATEGORY_LABELS, category)));
}

function isEvaluation(value: unknown): value is SuggestionEvaluation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SuggestionEvaluation>;
  if (candidate.kind === 'all-good') return isNonEmptyString(candidate.message)
    && validEvaluationEvidence(candidate.evidence) && candidate.evidence.source !== 'none'
    && validCategories(candidate.unsupportedCategories);
  if (candidate.kind === 'intentional') return isNonEmptyString(candidate.message)
    && validEvaluationEvidence(candidate.evidence) && candidate.evidence.source === 'none';
  if (candidate.kind === 'actionable') {
    return isNonEmptyString(candidate.message)
      && isNonEmptyString(candidate.title)
      && isNonEmptyString(candidate.reason)
      && isNonEmptyString(candidate.cue) && Object.hasOwn(cueCopy, candidate.cue)
      && isNonEmptyString(candidate.category) && Object.hasOwn(CATEGORY_LABELS, candidate.category)
      && validEvaluationEvidence(candidate.evidence) && candidate.evidence.source !== 'none'
      && validCategories(candidate.unsupportedCategories);
  }
  if (candidate.kind === 'unavailable') {
    return isNonEmptyString(candidate.reason)
      && isNonEmptyString(candidate.message)
      && Array.isArray(candidate.unsupportedCategories) && validCategories(candidate.unsupportedCategories);
  }
  return false;
}

function createIdleSnapshot(): SuggestionJobSnapshot {
  return { status: 'idle', jobId: null, request: null, attempt: 0 };
}

/** Create an inert request-driven Visual Suggestions controller. */
export function createSuggestionJobController(options: SuggestionJobControllerOptions = {}): SuggestionJobController {
  const evaluator = options.evaluator ?? evaluateSuggestionRequest;
  const timeoutMs = options.timeoutMs ?? SUGGESTION_JOB_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? monotonicNowMs;
  const listeners = new Set<(snapshot: SuggestionJobSnapshot) => void>();
  const diagnostics: SuggestionJobDiagnostics = {
    starts: 0,
    evaluations: 0,
    completed: 0,
    cancellations: 0,
    staleResults: 0,
    timeouts: 0,
    errors: 0,
  };
  let identity: SuggestionJobIdentity | null = null;
  let snapshot = createIdleSnapshot();
  let active: ActiveJob | null = null;
  let settledPromise: Promise<SuggestionJobSnapshot> = Promise.resolve(snapshot);

  function emit(next: SuggestionJobSnapshot): SuggestionJobSnapshot {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function clearTimeoutFor(job: ActiveJob): void {
    if (job.timeoutHandle !== null) {
      clearTimeout(job.timeoutHandle);
      job.timeoutHandle = null;
    }
  }

  function resolveActive(job: ActiveJob, next: SuggestionJobSnapshot): void {
    clearTimeoutFor(job);
    if (active?.jobId === job.jobId) active = null;
    job.resolveSettled(next);
  }

  function requestIsCurrent(job: ActiveJob): boolean {
    return active?.jobId === job.jobId && sameIdentity(identity, job.request);
  }

  function stopActive(reason: SuggestionCancelReason | 'stale-request'): void {
    const job = active;
    if (!job) return;
    clearTimeoutFor(job);
    active = null;
    job.controller.abort(reason);
    diagnostics.cancellations += 1;
  }

  function settleWithEvaluation(job: ActiveJob, evaluation: SuggestionEvaluation): void {
    if (!requestIsCurrent(job)) {
      diagnostics.staleResults += 1;
      return;
    }
    const status: SuggestionJobStatus = evaluation.kind === 'actionable'
      ? 'result'
      : evaluation.kind === 'intentional'
        ? 'unavailable'
        : evaluation.kind;
    const next = emit({
      status,
      jobId: job.jobId,
      request: job.request,
      evaluation,
      startedAtMs: snapshot.startedAtMs,
      finishedAtMs: now(),
      attempt: job.attempt,
    });
    diagnostics.completed += 1;
    resolveActive(job, next);
  }

  function settleUnavailable(job: ActiveJob, reason: SuggestionUnavailableReason, message: string): void {
    settleWithEvaluation(job, unavailable(reason, message));
  }

  function launch(request: SuggestionJobRequest, attempt: number): SuggestionJobSnapshot {
    const jobId = `suggestion-${jobIdSegment(request.sessionId)}-${jobIdSegment(request.lensGeneration)}-${++globalSuggestionSequence}`;
    const abortController = new AbortController();
    let resolveSettled!: (next: SuggestionJobSnapshot) => void;
    const settled = new Promise<SuggestionJobSnapshot>(resolve => {
      resolveSettled = resolve;
    });
    const job: ActiveJob = {
      jobId,
      request,
      controller: abortController,
      attempt,
      resolveSettled,
      timeoutHandle: null,
    };
    active = job;
    diagnostics.starts += 1;
    settledPromise = settled;
    const loading = emit({
      status: 'loading',
      jobId,
      request,
      startedAtMs: now(),
      attempt,
    });

    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SUGGESTION_JOB_DEFAULT_TIMEOUT_MS;
    job.timeoutHandle = setTimeout(() => {
      if (!requestIsCurrent(job)) return;
      diagnostics.timeouts += 1;
      job.controller.abort('timeout');
      settleUnavailable(job, 'timeout', 'Visual Suggestions took too long. Try again when the camera signal is ready.');
    }, timeout);

    Promise.resolve()
      .then(() => {
        if (!requestIsCurrent(job)) {
          diagnostics.staleResults += 1;
          return SKIPPED_EVALUATION;
        }
        diagnostics.evaluations += 1;
        return evaluator(request, {
          signal: abortController.signal,
          jobId,
          maxEvaluations: SUGGESTION_JOB_MAX_EVALUATIONS,
        });
      })
      .then(result => {
        if (result === SKIPPED_EVALUATION) return;
        if (!requestIsCurrent(job)) {
          diagnostics.staleResults += 1;
          return;
        }
        if (!isEvaluation(result)) {
          diagnostics.errors += 1;
          settleUnavailable(job, 'evaluator-error', 'Visual Suggestions returned an unreadable result.');
          return;
        }
        settleWithEvaluation(job, result);
      })
      .catch(() => {
        if (!requestIsCurrent(job)) {
          diagnostics.staleResults += 1;
          return;
        }
        diagnostics.errors += 1;
        settleUnavailable(job, 'evaluator-error', 'Visual Suggestions are unavailable right now.');
      });

    return loading;
  }

  function bind(nextIdentity: SuggestionJobIdentity): SuggestionJobSnapshot {
    if (!isIdentity(nextIdentity)) {
      return emit({
        ...snapshot,
        status: 'unavailable',
        evaluation: unavailable('invalid-request', 'Visual Suggestions need a current camera identity.'),
      });
    }
    if (sameIdentity(identity, nextIdentity)) return snapshot;
    const previousRequest = snapshot.request;
    const activeJob = active;
    const changed = identity !== null;
    identity = { ...nextIdentity };
    if (activeJob) stopActive('stale-request');
    if (changed && previousRequest && !sameIdentity(previousRequest, nextIdentity)) {
      const next = emit({
        ...snapshot,
        status: 'stale',
        reason: nextIdentity.sessionId !== previousRequest.sessionId ? 'session-ended' : 'camera-changed',
      });
      if (activeJob) resolveActive(activeJob, next);
      return next;
    }
    if (activeJob) resolveActive(activeJob, snapshot);
    return snapshot;
  }

  function start(request: SuggestionJobRequest): SuggestionJobSnapshot {
    if (!validRequest(request)) {
      return emit({
        status: 'unavailable',
        jobId: null,
        request: null,
        evaluation: unavailable('invalid-request', 'Visual Suggestions need a current camera identity.'),
        attempt: snapshot.attempt,
      });
    }
    if (identity === null) identity = { sessionId: request.sessionId, lensGeneration: request.lensGeneration, intent: request.intent };
    if (!sameIdentity(identity, request)) {
      return emit({
        ...snapshot,
        status: 'stale',
        reason: 'stale-request',
      });
    }
    if (active && sameIdentity(active.request, request)) return snapshot;
    if (active) {
      const replacedJob = active;
      stopActive('replaced');
      resolveActive(replacedJob, {
        ...snapshot,
        status: 'cancelled',
        reason: 'replaced',
        finishedAtMs: now(),
      });
    }
    const attempt = snapshot.request && sameIdentity(snapshot.request, request)
      ? snapshot.attempt + 1
      : 1;
    return launch({ ...request }, attempt);
  }

  function retry(freshEvidence?: CoachVisionEvidence): SuggestionJobSnapshot {
    if (!snapshot.request || identity === null) return snapshot;
    if (snapshot.status === 'loading') return snapshot;
    const { evidence, ...requestWithoutEvidence } = snapshot.request;
    return start({
      ...requestWithoutEvidence,
      ...identity,
      requestedAtMs: now(),
      ...(freshEvidence ? { evidence: freshEvidence } : {}),
    });
  }

  function cancel(reason: SuggestionCancelReason = 'manual'): SuggestionJobSnapshot {
    if (!snapshot.request && !active) return snapshot;
    const activeJob = active;
    if (activeJob) stopActive(reason);
    const next = emit({
      ...snapshot,
      status: 'cancelled',
      reason,
      finishedAtMs: now(),
    });
    if (activeJob) resolveActive(activeJob, next);
    return next;
  }

  function invalidate(
    nextIdentity: SuggestionJobIdentity,
    reason: 'camera-changed' | 'lens-changed' | 'session-ended' = 'camera-changed',
  ): SuggestionJobSnapshot {
    const previousRequest = snapshot.request;
    const activeJob = active;
    if (activeJob) stopActive('stale-request');
    identity = isIdentity(nextIdentity) ? { ...nextIdentity } : null;
    const next = previousRequest && (!identity || !sameIdentity(previousRequest, identity))
      ? emit({ ...snapshot, status: 'stale', reason })
      : snapshot;
    if (activeJob) resolveActive(activeJob, next);
    return next;
  }

  return {
    bind,
    start,
    retry,
    cancel,
    invalidate,
    getSnapshot: () => snapshot,
    getDiagnostics: () => copyDiagnostics(diagnostics),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenSettled: () => settledPromise,
  };
}
