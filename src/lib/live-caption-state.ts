// Type-only, so this does not pull the native module or React Native into a
// plain Node test run. The reason vocabulary is the native module's wire
// contract, so it is owned there and re-exported here for app consumers.
import type {
  CaptionFailureReason,
  CaptionInterruptionReason,
  CaptionUnavailableReason,
} from '../../modules/one-take-captions';

export type { CaptionFailureReason, CaptionInterruptionReason, CaptionUnavailableReason };

export interface CaptionSegmentUpdate {
  id: string;
  t0: number;
  t1: number;
  text: string;
  isFinal: boolean;
}

export interface CaptionUpdate {
  sessionId: string;
  sequence: number;
  text: string;
  isFinal: boolean;
  segments?: CaptionSegmentUpdate[];
}

export function captionState(sessionId: string): CaptionUpdate {
  return { sessionId, sequence: -1, text: '', isFinal: false };
}

export function reduceCaption(state: CaptionUpdate, update: CaptionUpdate): CaptionUpdate {
  if (update.sessionId !== state.sessionId || update.sequence <= state.sequence) return state;
  return update;
}

/**
 * Merge a caption revision into the retained transcript.
 *
 * Events are accepted in sequence order, so a later occurrence of a segment id
 * is the latest revision of that utterance, including its finality and timing.
 * Ordering is fully determined by source time and then by id, which is what
 * makes a replay of the same recorded events byte-identical to the live run.
 */
export function mergeCaptionSegments(
  previous: readonly CaptionSegmentUpdate[],
  segments: readonly CaptionSegmentUpdate[],
): CaptionSegmentUpdate[] {
  const history = new Map(previous.map(segment => [segment.id, segment]));
  for (const segment of segments) {
    if (typeof segment?.id === 'string' && segment.id.length > 0) history.set(segment.id, segment);
  }
  return [...history.values()].sort((a, b) =>
    a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id));
}

/**
 * Namespace a retried session's segment ids and offset its restarted clock.
 *
 * A retry after a mid-take failure starts a new native session, and the
 * recognizer restarts its segment ids from the beginning. Without a namespace
 * those ids would collide with the utterances recognized before the failure
 * and silently overwrite them. Attempt 0 is the first session and is left
 * untouched, so an ordinary take keeps the ids the native module produced.
 * The offset is the maximum retained t1, fixed for the entire retry attempt.
 */
export function namespaceCaptionSegments(
  segments: readonly CaptionSegmentUpdate[],
  attempt: number,
  offsetSeconds = 0,
): CaptionSegmentUpdate[] {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError('Caption retry attempt must be a non-negative integer.');
  }
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
    throw new RangeError('Caption retry offset must be a non-negative finite number.');
  }
  if (attempt === 0) return [...segments];
  return segments.map(segment => ({
    ...segment,
    id: `r${attempt}:${segment.id}`,
    t0: segment.t0 + offsetSeconds,
    t1: segment.t1 + offsetSeconds,
  }));
}

export interface CaptionReplayResult {
  sessionId: string;
  sequence: number;
  text: string;
  isFinal: boolean;
  segments: CaptionSegmentUpdate[];
}

/**
 * Replay a recorded caption event log exactly as the live hook consumes it.
 *
 * The hook uses this same function, so a recorded session replayed offline
 * cannot drift from what the camera screen showed.  Events from another
 * session and revisions that are not newer than the accepted sequence are
 * dropped wherever they appear in the log.
 */
export function replayCaptionSession(
  sessionId: string,
  events: readonly CaptionUpdate[],
): CaptionReplayResult {
  let caption = captionState(sessionId);
  let segments: CaptionSegmentUpdate[] = [];
  for (const event of events) {
    const next = reduceCaption(caption, event);
    if (next === caption) continue;
    caption = next;
    if (Array.isArray(event.segments)) segments = mergeCaptionSegments(segments, event.segments);
  }
  return {
    sessionId,
    sequence: caption.sequence,
    text: caption.text,
    isFinal: caption.isFinal,
    segments,
  };
}

export type LiveCaptionStatus =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'delayed'
  | 'stopping'
  | 'stopped'
  | 'unavailable'
  | 'interrupted';

export interface CaptionFailure {
  status: 'unavailable' | 'interrupted';
  reason: CaptionFailureReason;
  retryable: boolean;
}

export interface CaptionStatusUpdate {
  sessionId: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface LiveCaptionSession {
  sessionId: string;
  status: LiveCaptionStatus;
  reason: CaptionFailureReason | null;
  message: string;
  retryable: boolean;
}

const INTERRUPTION_REASONS: readonly CaptionInterruptionReason[] = [
  'audio-focus-lost',
  'audio-route-changed',
  'lifecycle-interrupted',
];

const UNAVAILABLE_REASONS: readonly CaptionUnavailableReason[] = [
  'model-missing',
  'model-corrupt',
  'initialization-failed',
  'unsupported-device',
  'permission-denied',
  'unknown',
];

/**
 * Message patterns are ordered from most specific to least.  A checksum
 * mismatch also mentions the model, so corruption must be recognized before
 * the missing-asset pattern.
 */
const MESSAGE_REASONS: readonly [RegExp, CaptionFailureReason][] = [
  [/checksum mismatch|hash mismatch|corrupt/, 'model-corrupt'],
  [/model asset .* is unavailable|prepare_moonshine|install caption model|model directory/, 'model-missing'],
  [/permission/, 'permission-denied'],
  // Anchored to the exact device-support sentences the native module emits.
  // A bare "unsupported" would also match failures such as an unsupported PCM
  // encoding or channel count, which are retryable audio problems and must not
  // tell the user their phone cannot run the model.
  [/arm64|android api 26 or newer|android 8 or newer/, 'unsupported-device'],
  [/audio focus/, 'audio-focus-lost'],
  [/audio route|route change|headset|bluetooth/, 'audio-route-changed'],
  [/interrupt|background/, 'lifecycle-interrupted'],
];

/**
 * Name the failure so the overlay can say what is wrong and whether another
 * attempt can help.
 *
 * A reason reported by the native module is authoritative.  The message
 * patterns only exist so an older native build, or a JavaScript-side failure
 * that never reached the module, is still classified instead of being shown
 * as a generic error.  Nothing here invents a cause: an unrecognized failure
 * stays `initialization-failed`, and a failure with no information at all
 * stays `unknown`.
 */
export function classifyCaptionFailure(reason?: string, message?: string): CaptionFailure {
  const named = asFailureReason(reason) ?? matchMessage(message);
  const resolved: CaptionFailureReason = named ?? (message ? 'initialization-failed' : 'unknown');
  return {
    status: isInterruption(resolved) ? 'interrupted' : 'unavailable',
    reason: resolved,
    retryable: resolved !== 'unsupported-device',
  };
}

export function liveCaptionSession(sessionId: string): LiveCaptionSession {
  return {
    sessionId,
    status: sessionId ? 'preparing' : 'idle',
    reason: null,
    message: '',
    retryable: false,
  };
}

/**
 * Apply one native status event to the session the screen is showing.
 *
 * A failure outlives the shutdown that follows it, so the overlay does not
 * replace "captions are unavailable" with a calm "stopped" while the reason
 * is still the actionable information.  Recognition resuming clears it, and
 * so does starting the next recording, which is what makes an interruption
 * recover without a manual retry.
 */
export function reduceLiveCaptionStatus(
  state: LiveCaptionSession,
  update: CaptionStatusUpdate,
): LiveCaptionSession {
  if (update.sessionId !== state.sessionId) return state;
  const message = update.message || state.message;

  if (update.status === 'error' || update.status === 'interrupted') {
    // The native module decides whether the take survives, so its status owns
    // the interrupted/unavailable split. Classification only refines why.
    const failure = classifyCaptionFailure(update.reason, update.message);
    if (update.status === 'interrupted') {
      return {
        sessionId: state.sessionId,
        status: 'interrupted',
        reason: isInterruption(failure.reason) ? failure.reason : 'lifecycle-interrupted',
        message,
        retryable: true,
      };
    }
    return {
      sessionId: state.sessionId,
      status: 'unavailable',
      reason: failure.reason,
      message,
      retryable: failure.retryable,
    };
  }

  if (update.status === 'preparing' || update.status === 'listening' || update.status === 'delayed') {
    return {
      sessionId: state.sessionId,
      status: update.status,
      reason: null,
      message: update.message ?? '',
      retryable: false,
    };
  }

  if (update.status === 'stopping' || update.status === 'stopped') {
    const failed = state.status === 'unavailable' || state.status === 'interrupted';
    return failed ? { ...state, message } : { ...state, status: update.status, message };
  }

  return state;
}

function asFailureReason(reason?: string): CaptionFailureReason | null {
  if (!reason) return null;
  const known = [...UNAVAILABLE_REASONS, ...INTERRUPTION_REASONS]
    .find(candidate => candidate === reason);
  return known ?? null;
}

function matchMessage(message?: string): CaptionFailureReason | null {
  if (!message) return null;
  const text = message.toLowerCase();
  return MESSAGE_REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function isInterruption(reason: CaptionFailureReason): reason is CaptionInterruptionReason {
  return INTERRUPTION_REASONS.some(candidate => candidate === reason);
}
