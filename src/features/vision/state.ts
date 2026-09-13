export type VisionLensFacing = 'front' | 'back';

export type VisionEngine = 'mlkit-face' | 'none' | 'unknown';

export type VisionProcessor = 'cpu-fallback' | 'npu' | 'unknown';

export type VisionUnavailableReason =
  | 'model-loading'
  | 'no-frame-pipeline'
  | 'model-error'
  | 'runtime-unavailable'
  | 'unsupported-device'
  | 'thermal-pressure'
  | 'stale-frame'
  | 'camera-binding-failed'
  | 'activity-unavailable'
  | 'permission'
  | 'unknown';

export type VisionStatus = 'idle' | 'pending' | 'ready' | 'unavailable' | 'stopped';

export type VisionFace = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  trackingId?: number | null;
};

export type VisionEvent = VisionStatusEvent | VisionFrameEvent;

export type VisionStatusEvent = {
  type: 'status';
  sessionId: string;
  lensFacing: VisionLensFacing;
  status: Exclude<VisionStatus, 'idle'>;
  reason?: VisionUnavailableReason;
  engine: VisionEngine;
  processor: VisionProcessor;
};

export type VisionFrameEvent = {
  type: 'frame';
  sessionId: string;
  lensFacing: VisionLensFacing;
  frameId: number;
  frameCapturedAtMs: number;
  facePresent: boolean | null;
  stable: boolean;
  faces: readonly VisionFace[];
  exposure?: { mean: number; clipped: number; dark: number };
};

export type FacePresence = 'unknown' | 'present' | 'absent';

export type VisionState = {
  status: VisionStatus;
  sessionId: string | null;
  lensFacing: VisionLensFacing | null;
  reason?: VisionUnavailableReason;
  engine: VisionEngine;
  processor: VisionProcessor;
  facePresence: FacePresence;
  faceStable: boolean;
  faces: readonly VisionFace[];
  exposure?: { mean: number; clipped: number; dark: number };
  frameId: number | null;
  lastFrameCapturedAtMs: number | null;
};

export type VisionEvidence =
  | {
      status: 'ready';
      sessionId: string;
      lensFacing: VisionLensFacing;
      engine: VisionEngine;
      processor: VisionProcessor;
      frameCapturedAtMs: number;
      facePresence: FacePresence;
      faceStable: boolean;
      faces: readonly VisionFace[];
  exposure?: { mean: number; clipped: number; dark: number };
    }
  | {
      status: 'pending' | 'unavailable';
      sessionId: string | null;
      lensFacing: VisionLensFacing | null;
      engine: VisionEngine;
      processor: VisionProcessor;
      reason: VisionUnavailableReason;
    };

/**
 * The frame producer and consumer use the same elapsed-realtime millisecond
 * clock.  A missing frame beyond this window is not safe evidence for a
 * take-selection decision.
 */
export const VISION_STALE_FRAME_MS = 500;

export function createVisionState(): VisionState {
  return {
    status: 'idle',
    sessionId: null,
    lensFacing: null,
    engine: 'unknown',
    processor: 'unknown',
    facePresence: 'unknown',
    faceStable: false,
    faces: [],
    frameId: null,
    lastFrameCapturedAtMs: null,
  };
}

function sameIdentity(state: VisionState, event: VisionEvent): boolean {
  return state.sessionId === event.sessionId && state.lensFacing === event.lensFacing;
}

function stateForIdentity(sessionId: string, lensFacing: VisionLensFacing): VisionState {
  return {
    ...createVisionState(),
    sessionId,
    lensFacing,
    status: 'pending',
  };
}

/**
 * Starts a new identity before native callbacks are accepted.  This explicit
 * boundary prevents a delayed status event from a previous take or lens flip
 * from replacing the current session.
 */
export function beginVisionSession(
  _state: VisionState,
  sessionId: string,
  lensFacing: VisionLensFacing,
): VisionState {
  return stateForIdentity(sessionId, lensFacing);
}

/**
 * Applies only events belonging to the currently active session/lens pair.
 * Native callbacks can finish after stop or camera flip, so accepting a late
 * event would reintroduce stale face evidence into a new take.
 */
export function reduceVisionEvent(
  state: VisionState,
  event: VisionEvent,
  _nowMs: number,
): VisionState {
  if (state.sessionId === null || !sameIdentity(state, event)) return state;

  if (event.type === 'status') {
    return {
      ...state,
      status: event.status,
      reason: event.reason,
      engine: event.engine,
      processor: event.processor,
      ...(event.status === 'pending' || event.status === 'unavailable' || event.status === 'stopped'
        ? {
            facePresence: 'unknown' as const,
            faceStable: false,
            faces: [],
            frameId: null,
            lastFrameCapturedAtMs: null,
          }
        : {}),
    };
  }

  if (state.lastFrameCapturedAtMs !== null
    && event.frameCapturedAtMs < state.lastFrameCapturedAtMs) {
    return state;
  }

  return {
    ...state,
    status: 'ready',
    reason: undefined,
    facePresence: event.facePresent === true
      ? 'present'
      : event.facePresent === false
        ? 'absent'
        : 'unknown',
    faceStable: event.stable,
    faces: event.faces,
    exposure: event.exposure,
    frameId: event.frameId,
    lastFrameCapturedAtMs: event.frameCapturedAtMs,
  };
}

/**
 * Clears face evidence after a producer timeout.  The session remains
 * identifiable so a late callback from that same session cannot silently
 * revive a frame after an explicit stale reset.
 */
export function markVisionStale(state: VisionState, nowMs: number): VisionState {
  if (state.status !== 'ready' || state.lastFrameCapturedAtMs === null) return state;
  const ageMs = nowMs - state.lastFrameCapturedAtMs;
  if (!Number.isFinite(ageMs) || ageMs <= VISION_STALE_FRAME_MS) return state;

  return {
    ...state,
    status: 'unavailable',
    reason: 'stale-frame',
    facePresence: 'unknown',
    faceStable: false,
    faces: [],
    frameId: null,
    lastFrameCapturedAtMs: null,
  };
}

/**
 * Returns a pure vision contract for downstream consumers. Face detection
 * itself does not claim calibrated framing cues, so this contract carries raw
 * presence and bounds; coach policy maps only separately validated cues.
 */
export function toVisionEvidence(state: VisionState, nowMs: number): VisionEvidence {
  if (state.status === 'pending') {
    return {
      status: 'pending',
      sessionId: state.sessionId,
      lensFacing: state.lensFacing,
      engine: state.engine,
      processor: state.processor,
      reason: state.reason ?? 'model-loading',
    };
  }

  if (state.status !== 'ready' || state.lastFrameCapturedAtMs === null) {
    return {
      status: 'unavailable',
      sessionId: state.sessionId,
      lensFacing: state.lensFacing,
      engine: state.engine,
      processor: state.processor,
      reason: state.reason ?? 'no-frame-pipeline',
    };
  }

  const ageMs = nowMs - state.lastFrameCapturedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > VISION_STALE_FRAME_MS) {
    return {
      status: 'unavailable',
      sessionId: state.sessionId,
      lensFacing: state.lensFacing,
      engine: state.engine,
      processor: state.processor,
      reason: 'stale-frame',
    };
  }

  return {
    status: 'ready',
    sessionId: state.sessionId!,
    lensFacing: state.lensFacing!,
    engine: state.engine,
    processor: state.processor,
    frameCapturedAtMs: state.lastFrameCapturedAtMs,
    facePresence: state.facePresence,
    faceStable: state.faceStable,
    faces: state.faces,
    exposure: state.exposure,
  };
}
