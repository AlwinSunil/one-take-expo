/**
 * Pure state and presentation helpers for the optional Assisted Mode live
 * transcript.  The recorder owns the native session; this adapter only
 * orders events and keeps delayed or unavailable recognition honest.
 */

export type LiveTranscriptStatus =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'delayed'
  | 'stopping'
  | 'stopped'
  | 'unavailable'
  | 'error';

export interface LiveTranscriptSegment {
  id: string;
  t0: number;
  t1: number;
  text: string;
  isFinal: boolean;
}

export interface LiveTranscriptEvent {
  sessionId: string;
  sequence: number;
  text?: string;
  isFinal?: boolean;
  status?: LiveTranscriptStatus | string;
  message?: string;
  segments?: readonly LiveTranscriptSegment[];
}

export interface LiveTranscriptState {
  sessionId: string;
  sequence: number;
  text: string;
  isFinal: boolean;
  status: LiveTranscriptStatus;
  message: string;
  segments: LiveTranscriptSegment[];
}

export interface LiveTranscriptStateOptions {
  /** Bounds live memory while the recorder retains its full stop result. */
  maxSegments?: number;
}

export type LiveTranscriptDisplayState =
  | 'preparing'
  | 'no-speech'
  | 'provisional'
  | 'final'
  | 'delayed'
  | 'unavailable'
  | 'stopped';

export interface LiveTranscriptViewModel {
  state: LiveTranscriptDisplayState;
  label: string;
  text: string;
  hint: string;
  hasSpeech: boolean;
  isFinal: boolean;
  truncated: boolean;
}

export interface LiveTranscriptTextInput {
  text: string;
  segments: readonly LiveTranscriptSegment[];
}

const DEFAULT_MAX_SEGMENTS = 256;
const DEFAULT_MAX_CHARACTERS = 4_000;

export function createLiveTranscriptState(
  sessionId: string,
  options: LiveTranscriptStateOptions = {},
): LiveTranscriptState {
  if (!sessionId.trim()) throw new Error('live transcript session id is required');
  validateMaxSegments(options.maxSegments ?? DEFAULT_MAX_SEGMENTS);
  return {
    sessionId,
    sequence: -1,
    text: '',
    isFinal: false,
    status: 'idle',
    message: '',
    segments: [],
  };
}

/**
 * Apply an event from one native session.  Stale sessions and sequence
 * numbers are ignored; final segment state is sticky across a later partial.
 */
export function reduceLiveTranscript(
  state: LiveTranscriptState,
  event: LiveTranscriptEvent,
  options: LiveTranscriptStateOptions = {},
): LiveTranscriptState {
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  validateMaxSegments(maxSegments);
  if (event.sessionId !== state.sessionId || event.sequence <= state.sequence) return state;
  if (!Number.isInteger(event.sequence) || event.sequence < 0) throw new RangeError('live transcript sequence must be a non-negative integer');

  const finalSegmentIds = new Set(state.segments.filter((segment) => segment.isFinal).map((segment) => segment.id));
  const hasNewProvisionalSegment = (event.segments ?? []).some((segment) => !segment.isFinal && !finalSegmentIds.has(segment.id));
  const stalePartialForFinalSegment = state.isFinal && event.isFinal === false && (event.segments?.length ?? 0) > 0 && !hasNewProvisionalSegment;
  const segments = mergeSegments(state.segments, event.segments ?? [], maxSegments);
  const eventText = typeof event.text === 'string' ? event.text.trim() : '';
  const derivedText = segments.slice(-64).map((segment) => segment.text.trim()).filter(Boolean).join('\n');
  const text = stalePartialForFinalSegment ? state.text : eventText || derivedText || state.text;
  const hasSegmentFinal = segments.length > 0 && segments.every((segment) => segment.isFinal);
  const isFinal = event.isFinal === true
    || (event.isFinal === undefined && hasSegmentFinal)
    || (event.isFinal === false && stalePartialForFinalSegment);
  const nextStatus = normalizeStatus(event.status ?? state.status);
  const status = (state.status === 'error' || state.status === 'unavailable')
    && (nextStatus === 'stopping' || nextStatus === 'stopped')
    ? state.status
    : nextStatus;
  return {
    sessionId: state.sessionId,
    sequence: event.sequence,
    text,
    isFinal,
    status,
    message: event.message ?? state.message,
    segments,
  };
}

export function visibleLiveTranscriptText(
  state: LiveTranscriptTextInput,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
): { text: string; truncated: boolean } {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) throw new RangeError('maxCharacters must be a positive integer');
  const full = (state.text.trim() || state.segments.slice(-64).map((segment) => segment.text.trim()).filter(Boolean).join('\n')).trim();
  if (full.length <= maxCharacters) return { text: full, truncated: false };
  const prefix = '…';
  const tail = maxCharacters === 1 ? '' : full.slice(-(maxCharacters - prefix.length)).trimStart();
  return { text: `${prefix}${tail}`, truncated: true };
}

export function buildLiveTranscriptView(
  state: LiveTranscriptTextInput & Pick<LiveTranscriptState, 'isFinal' | 'status' | 'message'>,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
): LiveTranscriptViewModel {
  const visible = visibleLiveTranscriptText(state, maxCharacters);
  const hasSpeech = visible.text.length > 0;
  if (state.status === 'preparing') {
    return { state: 'preparing', label: 'Preparing transcript', text: visible.text, hint: 'Getting ready…', hasSpeech, isFinal: state.isFinal, truncated: visible.truncated };
  }
  if (state.status === 'delayed') {
    return { state: 'delayed', label: 'Transcript catching up', text: visible.text, hint: 'Keep recording. Review the transcript after stopping.', hasSpeech, isFinal: state.isFinal, truncated: visible.truncated };
  }
  if (state.status === 'unavailable' || state.status === 'error') {
    return { state: 'unavailable', label: 'Transcript unavailable', text: visible.text, hint: state.message || 'Recording continues. Transcript recognition is unavailable for this take.', hasSpeech, isFinal: state.isFinal, truncated: visible.truncated };
  }
  if (state.status === 'stopped') {
    return {
      state: 'stopped',
      label: hasSpeech ? (state.isFinal ? 'Transcript ready' : 'Transcript incomplete') : 'No transcript received',
      text: visible.text,
      hint: hasSpeech
        ? (state.isFinal ? 'Live timing is approximate until the saved audio is reviewed.' : 'Some text is provisional. Review the transcript after stopping.')
        : 'No transcript was received. This does not establish whether speech was present; keep the original recording.',
      hasSpeech,
      isFinal: state.isFinal,
      truncated: visible.truncated,
    };
  }
  if (!hasSpeech) {
    return { state: 'no-speech', label: 'Listening', text: '', hint: 'Speak clearly near the microphone to see a transcript.', hasSpeech: false, isFinal: false, truncated: false };
  }
  return {
    state: state.isFinal ? 'final' : 'provisional',
    label: state.isFinal ? 'Final transcript' : 'Provisional transcript',
    text: visible.text,
    hint: state.isFinal ? 'Live timing is approximate until the saved audio is reviewed.' : 'This text may change while you speak.',
    hasSpeech,
    isFinal: state.isFinal,
    truncated: visible.truncated,
  };
}

function mergeSegments(
  current: readonly LiveTranscriptSegment[],
  incoming: readonly LiveTranscriptSegment[],
  maxSegments: number,
): LiveTranscriptSegment[] {
  const byId = new Map(current.map((segment) => [segment.id, { ...segment }]));
  for (const segment of incoming) {
    if (!segment || typeof segment.id !== 'string' || !segment.id.trim()) continue;
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0) continue;
    if (typeof segment.text !== 'string' || !segment.text.trim()) continue;
    const previous = byId.get(segment.id);
    if (previous?.isFinal && !segment.isFinal) continue;
    byId.set(segment.id, { ...segment, text: segment.text.trim() });
  }
  return [...byId.values()]
    .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id))
    .slice(-maxSegments);
}

function normalizeStatus(status: LiveTranscriptStatus | string): LiveTranscriptStatus {
  if (status === 'error') return 'error';
  if (status === 'unavailable') return 'unavailable';
  if (status === 'preparing' || status === 'listening' || status === 'delayed' || status === 'stopping' || status === 'stopped' || status === 'idle') return status;
  return 'unavailable';
}

function validateMaxSegments(value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError('maxSegments must be a positive integer');
}
