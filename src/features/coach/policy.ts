/**
 * The viewfinder coach is deliberately a policy layer.
 * It consumes observations produced by the single capture/vision owner and
 * never attempts to inspect camera frames itself.
 */

export type CoachCue =
  | 'face-clipping'
  | 'subject-clipping'
  | 'backlight'
  | 'background-distraction';

export type CoachIntent = 'talking-head' | 'product' | 'subject' | 'intentional-look';

export type SpeechState = 'silent' | 'speaking' | 'unknown';

export type CueTarget = 'selected-face' | 'selected-subject' | 'selected-product';

export type VisionUnavailableReason =
  | 'model-loading'
  | 'no-frame-pipeline'
  | 'model-error'
  | 'runtime-unavailable'
  | 'unsupported-device'
  | 'thermal-pressure'
  | 'stale-frame'
  | 'unknown';

/**
 * A measured observation must carry its producer identity and calibration
 * state. The coach does not manufacture confidence or infer quality from a
 * raw pixel statistic.
 *
 * Face clipping is the only current candidate with a proposed confidence
 * floor. Other cues intentionally omit confidence until their camera-frame
 * validation defines a defensible measure.
 */
export type MeasuredCueEvidence = {
  source: 'on-device-vision';
  detectorId: string;
  detectorVersion: string;
  target: CueTarget;
  calibrated: boolean;
} & (
  | { target: 'selected-face'; confidence?: number }
  | { target: 'selected-subject' | 'selected-product'; confidence?: never }
);

export interface MeasuredCueObservation {
  state: 'issue' | 'clear';
  stableForMs: number;
  measurement: MeasuredCueEvidence;
}

export interface UnsupportedCueObservation {
  state: 'unsupported';
  reason: string;
}

export type CueObservation = MeasuredCueObservation | UnsupportedCueObservation;

export interface ReadyVisionEvidence {
  status: 'ready';
  /** Timestamp from the frame producer's monotonic capture clock in ms. */
  frameCapturedAtMs: number;
  observations: Partial<Record<CoachCue, CueObservation>>;
}

export interface PendingVisionEvidence {
  status: 'pending';
  reason?: VisionUnavailableReason;
}

export interface UnavailableVisionEvidence {
  status: 'unavailable';
  reason: VisionUnavailableReason;
}

export type CoachVisionEvidence = ReadyVisionEvidence | PendingVisionEvidence | UnavailableVisionEvidence;

export interface CoachPolicyInput {
  enabled: boolean;
  intent: CoachIntent | null;
  recording: boolean;
  speechState: SpeechState;
  /** True only when the capture owner has observed an actual between-lines interval. */
  betweenLines: boolean;
  /** Current value from the same clock used by frameCapturedAtMs. */
  nowMs: number;
  /** Null means that no prompt has been shown during this take. */
  lastPromptAtMs: number | null;
  /** Identity of the prompt recorded at lastPromptAtMs, if any. */
  activeCue: CoachCue | null;
  /** Cues dismissed by the creator for this take. */
  dismissed: readonly CoachCue[];
  evidence: CoachVisionEvidence;
}

export const COACH_THRESHOLDS = {
  staleFrameMs: 500,
  issueStableMs: 1_500,
  clearStableMs: 1_000,
  promptCooldownMs: 15_000,
  faceConfidenceFloor: 0.9,
} as const;

export type CoachUnavailableStage =
  | 'pending'
  | 'unavailable'
  | 'stale-frame'
  | 'insufficient-evidence'
  | 'unstable-evidence'
  | 'invalid-evidence'
  | 'invalid-clock';

export type CoachHiddenReason =
  | 'disabled'
  | 'missing-intent'
  | 'quiet-during-speech'
  | 'waiting-between-lines'
  | 'prompt-cooldown'
  | 'dismissed';

export type CoachDecision =
  | {
      kind: 'prompt';
      cue: CoachCue;
      title: string;
      message: string;
      reason: string;
    }
  | { kind: 'all-good'; message: 'Your shot looks ready.' }
  | { kind: 'intentional'; message: 'Intentional look selected. Automatic suggestions are off.' }
  | {
      kind: 'analysis-unavailable';
      stage: CoachUnavailableStage;
      message: string;
    }
  | { kind: 'hidden'; reason: CoachHiddenReason };

export interface CoachTakeState {
  takeId: string;
  dismissed: readonly CoachCue[];
}

const cuePriority: readonly CoachCue[] = [
  'face-clipping',
  'subject-clipping',
  'backlight',
  'background-distraction',
];

const cuesByIntent: Record<Exclude<CoachIntent, 'intentional-look'>, readonly CoachCue[]> = {
  'talking-head': ['face-clipping', 'backlight', 'background-distraction'],
  product: ['subject-clipping', 'backlight', 'background-distraction'],
  subject: ['subject-clipping', 'backlight', 'background-distraction'],
};

const promptCopy: Record<CoachCue, { title: string; message: string; reason: string }> = {
  'face-clipping': {
    title: 'Framing',
    message: 'Give your face a little more room.',
    reason: 'Your selected face is touching the visible edge.',
  },
  'subject-clipping': {
    title: 'Framing',
    message: 'Bring your subject fully into view.',
    reason: 'Your selected subject is clipped by the visible frame.',
  },
  backlight: {
    title: 'Lighting',
    message: 'Try facing the light.',
    reason: 'Your selected subject needs visible detail against the surrounding light.',
  },
  'background-distraction': {
    title: 'Background',
    message: 'Check what’s behind you.',
    reason: 'A measured background cue found a distraction around your selected subject.',
  },
};

function unavailable(stage: CoachUnavailableStage): CoachDecision {
  const message = stage === 'pending'
    ? 'Visual suggestions are checking the camera signal.'
    : stage === 'stale-frame'
      ? 'Visual suggestions are paused until the camera signal is fresh.'
      : 'Visual suggestions are unavailable right now.';
  return { kind: 'analysis-unavailable', stage, message };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMeasurementValid(
  cue: CoachCue,
  measurement: unknown,
  intent: Exclude<CoachIntent, 'intentional-look'>,
): measurement is MeasuredCueEvidence {
  if (!measurement || typeof measurement !== 'object') return false;
  const value = measurement as Partial<MeasuredCueEvidence>;
  if (value.source !== 'on-device-vision'
    || !isNonEmptyString(value.detectorId)
    || !isNonEmptyString(value.detectorVersion)
    || value.calibrated !== true) return false;

  const expectedTarget: CueTarget = intent === 'talking-head'
    ? 'selected-face'
    : intent === 'product'
      ? 'selected-product'
      : 'selected-subject';
  if (value.target !== expectedTarget) return false;

  if (cue === 'face-clipping') {
    return value.target === 'selected-face'
      && typeof value.confidence === 'number'
      && Number.isFinite(value.confidence)
      && value.confidence >= COACH_THRESHOLDS.faceConfidenceFloor
      && value.confidence <= 1;
  }
  return value.target === expectedTarget;
}

type ObservationResult = 'issue' | 'clear' | 'unsupported' | 'unstable' | 'invalid';

function evaluateObservation(
  cue: CoachCue,
  observation: CueObservation | undefined,
  intent: Exclude<CoachIntent, 'intentional-look'>,
): ObservationResult {
  if (!observation) return 'unsupported';
  if (observation.state === 'unsupported') {
    return isNonEmptyString(observation.reason) ? 'unsupported' : 'invalid';
  }
  if (observation.state !== 'issue' && observation.state !== 'clear') return 'invalid';
  if (!isFiniteNonNegative(observation.stableForMs)
    || !isMeasurementValid(cue, observation.measurement, intent)) return 'invalid';
  if (observation.state === 'issue') {
    return observation.stableForMs >= COACH_THRESHOLDS.issueStableMs ? 'issue' : 'unstable';
  }
  return observation.stableForMs >= COACH_THRESHOLDS.clearStableMs ? 'clear' : 'unstable';
}

function isDismissed(dismissed: readonly CoachCue[], cue: CoachCue): boolean {
  return dismissed.includes(cue);
}

export function createCoachTakeState(takeId: string): CoachTakeState {
  return { takeId, dismissed: [] };
}

/**
 * Returns only dismissals belonging to the active take. This key check keeps
 * a take transition synchronous during render instead of waiting for an
 * effect to clear the previous take's state.
 */
export function getCoachTakeDismissals(state: CoachTakeState, takeId: string): readonly CoachCue[] {
  return state.takeId === takeId ? state.dismissed : [];
}

export function dismissCoachCue(state: CoachTakeState, takeId: string, cue: CoachCue): CoachTakeState {
  const previous = getCoachTakeDismissals(state, takeId);
  if (previous.includes(cue)) return { takeId, dismissed: previous };
  return { takeId, dismissed: [...previous, cue] };
}

/**
 * Selects one viewfinder state. The function is pure so the capture owner can
 * call it from render without starting work, changing camera state or
 * creating a render/effect feedback loop.
 */
export function chooseCoachView(input: CoachPolicyInput): CoachDecision {
  if (!input.enabled) return { kind: 'hidden', reason: 'disabled' };
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) return unavailable('invalid-clock');
  if (!input.intent) return { kind: 'hidden', reason: 'missing-intent' };
  if (input.intent === 'intentional-look') {
    return { kind: 'intentional', message: 'Intentional look selected. Automatic suggestions are off.' };
  }

  if (input.recording && (input.speechState !== 'silent')) {
    return { kind: 'hidden', reason: 'quiet-during-speech' };
  }
  if (input.recording && !input.betweenLines) {
    return { kind: 'hidden', reason: 'waiting-between-lines' };
  }

  if (input.evidence.status === 'pending') return unavailable('pending');
  if (input.evidence.status === 'unavailable') return unavailable('unavailable');

  const frameAgeMs = input.nowMs - input.evidence.frameCapturedAtMs;
  if (!Number.isFinite(frameAgeMs) || frameAgeMs < 0 || frameAgeMs > COACH_THRESHOLDS.staleFrameMs) {
    return unavailable('stale-frame');
  }
  if (!Number.isFinite(input.lastPromptAtMs ?? 0) || (input.lastPromptAtMs ?? 0) < 0) {
    return unavailable('invalid-clock');
  }

  let unsupported = false;
  let unstable = false;
  let invalid = false;
  let dismissedIssue = false;
  let cooldownIssue = false;
  const observations = input.evidence.observations ?? {};

  for (const cue of cuePriority) {
    if (!cuesByIntent[input.intent].includes(cue)) continue;
    const observation = observations[cue];
    const result = evaluateObservation(cue, observation, input.intent);
    if (result === 'unsupported') {
      unsupported = true;
      continue;
    }
    if (result === 'invalid') {
      invalid = true;
      continue;
    }
    if (result === 'unstable') {
      unstable = true;
      continue;
    }
    if (result !== 'issue') continue;
    if (isDismissed(input.dismissed, cue)) {
      dismissedIssue = true;
      continue;
    }

    if (input.lastPromptAtMs !== null
      && input.activeCue !== cue
      && input.nowMs - input.lastPromptAtMs < COACH_THRESHOLDS.promptCooldownMs) {
      cooldownIssue = true;
      continue;
    }
    return { kind: 'prompt', cue, ...promptCopy[cue] };
  }

  if (invalid) return unavailable('invalid-evidence');
  if (unstable) return unavailable('unstable-evidence');
  if (unsupported) return unavailable('insufficient-evidence');
  if (dismissedIssue) return { kind: 'hidden', reason: 'dismissed' };
  if (cooldownIssue) return { kind: 'hidden', reason: 'prompt-cooldown' };
  return { kind: 'all-good', message: 'Your shot looks ready.' };
}
