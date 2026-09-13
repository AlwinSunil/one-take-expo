import { useEffect, useMemo, useRef, useState } from 'react';

import nativeVision, {
  type VisionDeviceStatus,
  type VisionDiagnostics,
  type VisionLensFacing,
  type VisionStatusEvent,
} from '../../../modules/one-take-vision';

import { startVisionBinding } from './binding';
import { receiveVisionFrame } from './frame-receipt';

import {
  beginVisionSession,
  createVisionState,
  markVisionStale,
  reduceVisionEvent,
  toVisionEvidence,
  type VisionEvidence,
  type VisionState,
} from './state';

export interface UseVisionOptions {
  enabled: boolean;
  /** True only after CameraView's onCameraReady callback. */
  ready: boolean;
  lensFacing: VisionLensFacing;
  /** Recording begins only after this hook has had a chance to start. */
  recording: boolean;
  /** Stable per-take identity. A generated identity is used for standalone callers. */
  sessionId?: string;
}

export interface UseVisionResult {
  status: VisionState['status'];
  reason: VisionState['reason'];
  facePresence: VisionState['facePresence'];
  faceStable: boolean;
  faces: VisionState['faces'];
  device: VisionDeviceStatus | null;
  diagnostics: VisionDiagnostics | null;
  nowMs: number;
  evidence: VisionEvidence;
}

let generatedSessionId = 0;
let bindingGeneration = 0;

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function identityKey(sessionId: string, lensFacing: VisionLensFacing): string {
  return `${sessionId}:${lensFacing}`;
}

function toStateStatusEvent(event: VisionStatusEvent) {
  return {
    type: 'status' as const,
    sessionId: event.sessionId,
    lensFacing: event.lensFacing,
    status: event.status,
    reason: event.reason,
    engine: event.engine,
    processor: event.processor,
  };
}


/**
 * Owns the JS side of the optional native analyzer. It starts after the
 * existing CameraView is ready and before recording, then leaves the same
 * analyzer attached while recording is active. Camera recording is never
 * started, stopped or rebound by this hook.
 */
export function useVision({
  enabled,
  ready,
  lensFacing,
  recording,
  sessionId: requestedSessionId,
}: UseVisionOptions): UseVisionResult {
  const fallbackSessionId = useRef<string | null>(null);
  if (fallbackSessionId.current === null) {
    generatedSessionId += 1;
    fallbackSessionId.current = `vision-${generatedSessionId}`;
  }
  const sessionId = requestedSessionId ?? fallbackSessionId.current!;
  const key = identityKey(sessionId, lensFacing);
  const clockOffsetMs = useRef<number | null>(null);
  const activeIdentity = useRef<{ key: string; sessionId: string } | null>(null);
  const [state, setState] = useState(createVisionState);
  const stateRef = useRef(state);
  const [device, setDevice] = useState<VisionDeviceStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<VisionDiagnostics | null>(null);
  const [nowMs, setNowMs] = useState(monotonicNowMs);

  function updateState(nextState: VisionState): void {
    stateRef.current = nextState;
    setState(nextState);
  }

  useEffect(() => {
    clockOffsetMs.current = null;
    updateState(beginVisionSession(stateRef.current, sessionId, lensFacing));
  }, [sessionId, lensFacing]);

  useEffect(() => {
    if (!enabled || !ready) {
      return;
    }

    if (recording || activeIdentity.current?.key === key) return;

    // Never reuse native identity after background/resume or front/back/front.
    // Keep this binding attached throughout recording; source IDs are separate.
    const nativeSessionId = `${sessionId}:binding:${++bindingGeneration}`;
    const startIdentity = { key, sessionId: nativeSessionId };
    activeIdentity.current = startIdentity;
    clockOffsetMs.current = null;
    updateState(beginVisionSession(stateRef.current, nativeSessionId, lensFacing));

    if (!nativeVision) {
      updateState(reduceVisionEvent(
        stateRef.current,
        {
          type: 'status',
          sessionId: nativeSessionId,
          lensFacing,
          status: 'unavailable',
          reason: 'unsupported-device',
          engine: 'none',
          processor: 'unknown',
        },
        monotonicNowMs(),
      ));
      return;
    }

    const module = nativeVision;
    void startVisionBinding(
      () => module.start(nativeSessionId, lensFacing),
      () => activeIdentity.current === startIdentity,
      () => module.stop(nativeSessionId),
    ).then(result => {
      if (!result || activeIdentity.current !== startIdentity) return;
      if (result.status === 'unavailable') {
        updateState(reduceVisionEvent(
          stateRef.current,
          {
            type: 'status',
            sessionId: result.sessionId,
            lensFacing: result.lensFacing,
            status: 'unavailable',
            reason: result.reason,
            engine: result.engine,
            processor: result.processor,
          },
          monotonicNowMs(),
        ));
      }
    }).catch(() => {
      if (activeIdentity.current !== startIdentity) return;
      updateState(reduceVisionEvent(
        stateRef.current,
        {
          type: 'status',
          sessionId: nativeSessionId,
          lensFacing,
          status: 'unavailable',
          reason: 'unknown',
          engine: 'none',
          processor: 'unknown',
        },
        monotonicNowMs(),
      ));
    });

  }, [enabled, ready, recording, key, sessionId, lensFacing]);

  useEffect(() => {
    return () => {
      const active = activeIdentity.current;
      if (active) {
        activeIdentity.current = null;
        void nativeVision?.stop(active.sessionId).catch(() => undefined);
      }
    };
  }, [key]);

  useEffect(() => {
    if (enabled && ready) return;
    const active = activeIdentity.current;
    if (active) {
      activeIdentity.current = null;
      void nativeVision?.stop(active.sessionId).catch(() => undefined);
      updateState(beginVisionSession(stateRef.current, sessionId, lensFacing));
    }
  }, [enabled, ready]);

  useEffect(() => {
    if (!nativeVision || !enabled) {
      setDevice(null);
      setDiagnostics(null);
      return;
    }

    let cancelled = false;
    const module = nativeVision;
    const load = async () => {
      const nextDevice = await module.getDeviceStatus().catch(() => null);
      if (!cancelled) setDevice(nextDevice);
      if (__DEV__) {
        const nextDiagnostics = await module.getDiagnostics().catch(() => null);
        if (!cancelled) setDiagnostics(nextDiagnostics?.enabled ? nextDiagnostics : null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  useEffect(() => {
    if (!nativeVision) return;
    const statusSubscription = nativeVision.addListener('onVisionStatus', event => {
      if (activeIdentity.current?.sessionId !== event.sessionId
        || stateRef.current.lensFacing !== event.lensFacing) {
        return;
      }
      updateState(reduceVisionEvent(stateRef.current, toStateStatusEvent(event), monotonicNowMs()));
    });
    const frameSubscription = nativeVision.addListener('onVisionFrame', event => {
      if (activeIdentity.current?.sessionId !== event.sessionId
        || stateRef.current.lensFacing !== event.lensFacing) {
        return;
      }
      if (stateRef.current.sessionId !== event.sessionId
        || stateRef.current.lensFacing !== event.lensFacing) {
        return;
      }
      const receivedAtMs = monotonicNowMs();
      const receipt = receiveVisionFrame(stateRef.current, event, clockOffsetMs.current, receivedAtMs);
      clockOffsetMs.current = receipt.clockOffsetMs;
      setNowMs(receipt.nowMs);
      updateState(receipt.state);
    });
    return () => {
      statusSubscription.remove();
      frameSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const currentNowMs = monotonicNowMs();
      setNowMs(currentNowMs);
      updateState(markVisionStale(stateRef.current, currentNowMs));
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const evidence = useMemo(() => toVisionEvidence(state, nowMs), [state, nowMs]);
  return {
    status: state.status,
    reason: state.reason,
    facePresence: state.facePresence,
    faceStable: state.faceStable,
    faces: state.faces,
    device,
    diagnostics,
    nowMs,
    evidence,
  };
}
