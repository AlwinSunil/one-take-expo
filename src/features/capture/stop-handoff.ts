/** Capture transport only. The project owner persists these records and jobs. */
export interface CaptureScope {
  projectId: string;
  sourceId: string;
  takeId: string;
  captureSessionId: string;
  generation: string;
}

export interface CaptureEvent {
  id: string;
  scope: CaptureScope;
  kind: 'record-requested' | 'stop-requested' | 'original-saved';
  /** Source-relative estimate, never calibrated media presentation time. */
  relativeSeconds: number;
  provenance: {
    clock: 'js-performance-now';
    sourceZero: 'recordAsync-request';
    sourceZeroMonotonicMs: number;
    observedMonotonicMs: number;
    uncertaintySeconds: null;
  };
}

export function captureEvent(scope: CaptureScope, kind: CaptureEvent['kind'], sourceZeroMs: number, nowMs: number): CaptureEvent {
  if (Object.values(scope).some(value => typeof value !== 'string' || !value.trim())
    || !Number.isFinite(sourceZeroMs) || !Number.isFinite(nowMs) || sourceZeroMs < 0 || nowMs < sourceZeroMs) {
    throw new Error('Invalid capture identity or monotonic clock.');
  }
  return {
    id: `${scope.captureSessionId}:${kind}`,
    scope: { ...scope }, kind, relativeSeconds: (nowMs - sourceZeroMs) / 1000,
    provenance: { clock: 'js-performance-now', sourceZero: 'recordAsync-request',
      sourceZeroMonotonicMs: sourceZeroMs, observedMonotonicMs: nowMs, uncertaintySeconds: null },
  };
}

/** Resolves only after the existing store's durable original operation succeeds. */
export async function checkpointCaptureOriginal<T>(
  saveOriginal: () => Promise<T>,
  onDurable: (saved: T) => void,
): Promise<T> {
  const saved = await saveOriginal();
  onDurable(saved);
  return saved;
}
