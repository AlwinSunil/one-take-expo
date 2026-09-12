/**
 * Tier 1's additive setup layer.
 *
 * The incoming Tier 0 composition policy remains the only automatic coach.
 * This module maps the creator-facing Tier 1 shot vocabulary to that policy
 * and supplies manual setup guidance. It does not inspect frames, infer
 * quality, or manufacture vision evidence.
 */

export const TIER1_COACHING_DEFAULT_ENABLED = false;

/**
 * Speech signals are deliberately short-lived. A missing or old signal cannot
 * safely create a between-lines window while the camera is recording.
 */
export const TIER1_SPEECH_STALE_MS = 1_000;

export type Tier1Intent =
  | 'talking-head'
  | 'vlog'
  | 'product-demo'
  | 'intentional-look';

/** Creator-facing alias used by setup controls and capture adapters. */
export type Tier1ShotIntent = Tier1Intent;
export type Tier1CoachIntent = Tier1Intent;

/** The vocabulary accepted by the incoming Tier 0 CompositionCoach. */
export type CompositionCoachIntent =
  | 'talking-head'
  | 'subject'
  | 'product'
  | 'intentional-look';

export function toCompositionCoachIntent(
  intent: Tier1Intent | null,
): CompositionCoachIntent | null {
  if (intent === null) return null;
  switch (intent) {
    case 'talking-head':
      return 'talking-head';
    case 'vlog':
      // Vlogs can feature a selected moving subject. The Tier 0 subject path
      // keeps it from receiving face-only advice without a selected face.
      return 'subject';
    case 'product-demo':
      return 'product';
    case 'intentional-look':
      return 'intentional-look';
    default:
      return null;
  }
}

export type Tier1SetupCue =
  | 'subject-framing'
  | 'background-separation'
  | 'background-distraction'
  | 'lighting';

export interface Tier1ManualSetupTip {
  intent: Exclude<Tier1Intent, 'intentional-look'>;
  cue: Tier1SetupCue;
  title: string;
  /** The one short instruction shown to the creator. */
  message: string;
  /** Why the instruction may help, without claiming an automatic finding. */
  reason: string;
  /** A concrete creator-controlled action. */
  action: string;
  provenance: 'manual-creator-guidance';
}

const manualSetupTips: Record<Exclude<Tier1Intent, 'intentional-look'>, readonly Tier1ManualSetupTip[]> = {
  'talking-head': [
    {
      intent: 'talking-head',
      cue: 'subject-framing',
      title: 'Subject framing',
      message: 'Give your face a little room.',
      reason: 'A little headroom keeps a close crop from feeling cramped.',
      action: 'Move the phone back slightly or lower it.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'talking-head',
      cue: 'background-separation',
      title: 'Background separation',
      message: 'Leave a little space behind you.',
      reason: 'Space can help your outline read clearly against the background.',
      action: 'Step forward or change the camera angle a little.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'talking-head',
      cue: 'background-distraction',
      title: 'Background',
      message: 'Check what is behind you.',
      reason: 'An unintended object crossing your outline can pull attention away.',
      action: 'Shift the phone or move the object if it is not intentional.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'talking-head',
      cue: 'lighting',
      title: 'Lighting',
      message: 'Face a soft light.',
      reason: 'Light on the subject helps preserve visible detail.',
      action: 'Turn toward a window or place a lamp just to the side.',
      provenance: 'manual-creator-guidance',
    },
  ],
  vlog: [
    {
      intent: 'vlog',
      cue: 'subject-framing',
      title: 'Subject framing',
      message: 'Keep the subject you want noticed in view.',
      reason: 'A clear subject gives the viewer an easy place to look.',
      action: 'Leave room for the subject to move before you start.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'vlog',
      cue: 'background-separation',
      title: 'Background separation',
      message: 'Leave a little space around your subject.',
      reason: 'Space helps the subject read while the camera is moving.',
      action: 'Take one step back or choose a clearer angle.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'vlog',
      cue: 'background-distraction',
      title: 'Background',
      message: 'Check what is behind the subject.',
      reason: 'A competing object can distract from the moment you are showing.',
      action: 'Reframe slightly if the object is not part of the story.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'vlog',
      cue: 'lighting',
      title: 'Lighting',
      message: 'Turn the subject toward soft light.',
      reason: 'Soft light can keep moving subjects readable.',
      action: 'Rotate toward open shade or a nearby window.',
      provenance: 'manual-creator-guidance',
    },
  ],
  'product-demo': [
    {
      intent: 'product-demo',
      cue: 'subject-framing',
      title: 'Product framing',
      message: 'Keep the product and demonstrating hands in view.',
      reason: 'The product and the action together explain the demo.',
      action: 'Move the camera back until both fit comfortably.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'product-demo',
      cue: 'background-separation',
      title: 'Product separation',
      message: 'Give the product some space from the background.',
      reason: 'Space can make its shape and movement easier to follow.',
      action: 'Change the angle or move the product forward a little.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'product-demo',
      cue: 'background-distraction',
      title: 'Product background',
      message: 'Check what competes with the product.',
      reason: 'Unrelated shapes or bright objects can pull focus from the demo.',
      action: 'Reframe or move the competing object when it is not intentional.',
      provenance: 'manual-creator-guidance',
    },
    {
      intent: 'product-demo',
      cue: 'lighting',
      title: 'Product lighting',
      message: 'Light the product from the front or side.',
      reason: 'Even light helps the viewer see its details and your hands.',
      action: 'Turn the setup toward a soft window or lamp.',
      provenance: 'manual-creator-guidance',
    },
  ],
};

/**
 * Returns setup copy only. Intentional looks intentionally have no automatic
 * or corrective tip; the creator's chosen composition remains authoritative.
 */
export function getTier1ManualSetupTips(intent: Tier1Intent): readonly Tier1ManualSetupTip[] {
  if (!isTier1Intent(intent) || intent === 'intentional-look') return [];
  return manualSetupTips[intent].map(tip => ({ ...tip }));
}

export interface Tier1TipState {
  intent: Tier1Intent;
  dismissed: readonly Tier1SetupCue[];
}

export function createTier1TipState(intent: Tier1Intent): Tier1TipState {
  return { intent, dismissed: [] };
}

export function dismissTier1SetupTip(
  state: Tier1TipState,
  intent: Tier1Intent,
  cue: Tier1SetupCue,
): Tier1TipState {
  const previous = state.intent === intent ? state.dismissed : [];
  const knownCue = getTier1ManualSetupTips(intent).some(tip => tip.cue === cue);
  if (!knownCue || previous.includes(cue)) return { intent, dismissed: previous };
  return { intent, dismissed: [...previous, cue] };
}

export function revisitTier1SetupTips(_state: Tier1TipState, intent: Tier1Intent): Tier1TipState {
  // Keeping the previous state in the API makes the reset explicit for a
  // parent that stores setup state, while a changed intent starts fresh.
  return { intent, dismissed: [] };
}

export function getNextTier1SetupTip(
  state: Tier1TipState,
): Tier1ManualSetupTip | null {
  return getTier1ManualSetupTips(state.intent).find(tip => !state.dismissed.includes(tip.cue)) ?? null;
}

export type Tier1SpeechState = 'silent' | 'speaking' | 'unknown';

/**
 * Small, additive transcript seam. Session 1 can adapt its transcript state
 * into this shape without exposing transcript text to camera coaching.
 *
 * `observedAtMs` and `takeId` must come from the same monotonic clock and
 * active take as the camera owner. `betweenLines` is true only after an actual
 * observed pause. Unknown or stale values fail closed while recording.
 */
export interface Tier1TranscriptSignal {
  takeId: string;
  /** Same capture/lens generation as the current camera binding. */
  captureGeneration: string;
  observedAtMs: number;
  state: Tier1SpeechState;
  betweenLines: boolean;
}

/** Required coverage and action work has priority over optional advice. */
export interface Tier1PrioritySignals {
  /** Active take identity from the capture owner. */
  takeId: string;
  /** Monotonic timestamp at which this priority state was observed. */
  observedAtMs: number;
  /**
   * Capture/lens generation. The owner changes it when the take or camera
   * binding changes, so an old false value cannot clear newer required work.
   */
  captureGeneration: string;
  coverageOrActionRequired: boolean;
}

export interface Tier1CoachGateInput {
  enabled: boolean;
  intent: Tier1Intent | null;
  recording: boolean;
  nowMs: number;
  takeId: string;
  /** Same active capture/lens generation carried by priority signals. */
  captureGeneration: string;
  /** Optional during setup, required for a recording-time delegation. */
  speech?: Tier1TranscriptSignal | null;
  /** Omitted only by older callers that have no priority signal yet. */
  priority?: Tier1PrioritySignals | null;
}

export type Tier1CoachHiddenReason =
  | 'disabled'
  | 'missing-intent'
  | 'coverage-or-action-required'
  | 'priority-unknown'
  | 'priority-stale'
  | 'speech-active'
  | 'speech-unknown'
  | 'speech-stale'
  | 'waiting-between-lines'
  | 'invalid-clock';

export type Tier1CoachGate =
  | { kind: 'hidden'; reason: Tier1CoachHiddenReason }
  | { kind: 'intentional' }
  | {
      kind: 'delegate';
      intent: CompositionCoachIntent;
      recording: boolean;
      speechState: Tier1SpeechState;
      betweenLines: boolean;
    };

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isTier1Intent(value: unknown): value is Tier1Intent {
  return value === 'talking-head'
    || value === 'vlog'
    || value === 'product-demo'
    || value === 'intentional-look';
}

function speechIsStale(
  speech: Tier1TranscriptSignal | null | undefined,
  input: Tier1CoachGateInput,
): boolean {
  if (!speech) return false;
  if (speech.takeId !== input.takeId || speech.captureGeneration !== input.captureGeneration) return true;
  if (!isFiniteNonNegative(speech.observedAtMs)) return true;
  const ageMs = input.nowMs - speech.observedAtMs;
  return !Number.isFinite(ageMs) || ageMs < 0 || ageMs > TIER1_SPEECH_STALE_MS;
}

function priorityShapeIsValid(priority: Tier1PrioritySignals): boolean {
  return typeof priority.takeId === 'string'
    && priority.takeId.trim().length > 0
    && typeof priority.captureGeneration === 'string'
    && priority.captureGeneration.trim().length > 0
    && isFiniteNonNegative(priority.observedAtMs)
    && (priority.coverageOrActionRequired === true || priority.coverageOrActionRequired === false);
}

function priorityIsStale(
  priority: Tier1PrioritySignals | null | undefined,
  input: Tier1CoachGateInput,
): boolean {
  if (!priority) return false;
  if (priority.takeId !== input.takeId
    || priority.captureGeneration !== input.captureGeneration
    || !isFiniteNonNegative(priority.observedAtMs)) return true;
  const ageMs = input.nowMs - priority.observedAtMs;
  return !Number.isFinite(ageMs) || ageMs < 0 || ageMs > TIER1_SPEECH_STALE_MS;
}

/**
 * Gates optional coaching and maps intent for the existing Tier 0 coach.
 *
 * This function chooses no cue and performs no vision work. A `delegate`
 * result tells the capture owner it may invoke the existing CompositionCoach;
 * that policy remains responsible for measured evidence, cue priority,
 * cooldown, all-good and unavailable states.
 */
export function gateTier1Coach(input: Tier1CoachGateInput): Tier1CoachGate {
  if (!input.enabled) return { kind: 'hidden', reason: 'disabled' };
  if (!isFiniteNonNegative(input.nowMs)) return { kind: 'hidden', reason: 'invalid-clock' };
  if (!isTier1Intent(input.intent)) return { kind: 'hidden', reason: 'missing-intent' };

  const speech = input.speech;
  if (input.recording) {
    if (!input.priority) return { kind: 'hidden', reason: 'priority-unknown' };
    if (!priorityShapeIsValid(input.priority)) return { kind: 'hidden', reason: 'priority-unknown' };
    if (priorityIsStale(input.priority, input)) return { kind: 'hidden', reason: 'priority-stale' };
    if (input.priority.coverageOrActionRequired !== false) {
      if (input.priority.coverageOrActionRequired === true) {
        return { kind: 'hidden', reason: 'coverage-or-action-required' };
      }
      return { kind: 'hidden', reason: 'priority-unknown' };
    }
    if (speechIsStale(speech, input)) return { kind: 'hidden', reason: 'speech-stale' };
    if (!speech) return { kind: 'hidden', reason: 'speech-unknown' };
    if (speech.state === 'unknown') return { kind: 'hidden', reason: 'speech-unknown' };
    if (speech.state === 'speaking') return { kind: 'hidden', reason: 'speech-active' };
    if (speech.state !== 'silent') return { kind: 'hidden', reason: 'speech-unknown' };
    if (speech.betweenLines !== true) return { kind: 'hidden', reason: 'waiting-between-lines' };
  }
  if (!input.recording && input.priority && !priorityShapeIsValid(input.priority)) {
    return { kind: 'hidden', reason: 'priority-unknown' };
  }
  if (!input.recording && input.priority?.coverageOrActionRequired === true) {
    return { kind: 'hidden', reason: 'coverage-or-action-required' };
  }
  if (input.intent === 'intentional-look') return { kind: 'intentional' };

  /*
   * The branches above intentionally own only timing/priority gates. The
   * existing Tier 0 policy still decides measured cues and unavailable states.
   */

  return {
    kind: 'delegate',
    intent: toCompositionCoachIntent(input.intent)!,
    recording: input.recording,
    speechState: input.recording ? speech!.state : speech?.state ?? 'silent',
    betweenLines: input.recording ? speech!.betweenLines : speech?.betweenLines ?? false,
  };
}
