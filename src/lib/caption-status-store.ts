import { captionTimingReport, captionTimingState, type CaptionTimingReport } from './caption-timing.ts';
import type { CaptionFailureReason, LiveCaptionStatus } from './live-caption-state';

export type CaptionRetryResult = { ok: true } | { ok: false; message: string };
export type CaptionRetry = () => Promise<CaptionRetryResult>;

/**
 * What the capture lane needs to know about recognition.
 *
 * Deliberately smaller than the caption hook's own value: the camera route
 * needs the state and a way to recover, not the transcript.
 */
export interface CaptureCaptionStatus {
  status: LiveCaptionStatus;
  reason: CaptionFailureReason | null;
  message: string;
  retryable: boolean;
  retry: CaptionRetry;
  timing: CaptionTimingReport;
}

export interface CaptionStatusStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CaptureCaptionStatus;
  publish(next: CaptureCaptionStatus): void;
  reset(): void;
}

export const IDLE_CAPTION_STATUS: CaptureCaptionStatus = Object.freeze({
  status: 'idle',
  reason: null,
  message: '',
  retryable: false,
  retry: async () => ({ ok: false, message: 'Live captions are not running.' }),
  timing: captionTimingReport(captionTimingState()),
});

/**
 * A single-writer snapshot of caption status for `useSyncExternalStore`.
 *
 * The caption hook owns the microphone session; this store only republishes
 * what that hook already computed, so another route can read the state
 * without starting a second recognition session. An unchanged publish keeps
 * the previous snapshot object, which is what stops `useSyncExternalStore`
 * from re-rendering forever.
 */
export function createCaptionStatusStore(
  initial: CaptureCaptionStatus = IDLE_CAPTION_STATUS,
): CaptionStatusStore {
  const listeners = new Set<() => void>();
  let snapshot = initial;

  const publish = (next: CaptureCaptionStatus) => {
    if (isSameStatus(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    publish,
    reset: () => publish(initial),
  };
}

export const captionStatusStore = createCaptionStatusStore();

function isSameStatus(a: CaptureCaptionStatus, b: CaptureCaptionStatus): boolean {
  return a.status === b.status
    && a.reason === b.reason
    && a.message === b.message
    && a.retryable === b.retryable
    && a.retry === b.retry
    && a.timing === b.timing;
}
