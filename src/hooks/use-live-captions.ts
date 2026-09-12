import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import captions, { type CaptionSegment } from '../../modules/one-take-captions';
import {
  captionStatusStore,
  type CaptureCaptionStatus,
} from '@/lib/caption-status-store';
import {
  captionTimingReport,
  captionTimingState,
  reduceCaptionTiming,
  timingAdjustedStatus,
  type CaptionTimingStage,
} from '@/lib/caption-timing';
import {
  captionState,
  liveCaptionSession,
  mergeCaptionSegments,
  reduceCaption,
  reduceLiveCaptionStatus,
} from '@/lib/live-caption-state';

let nextSession = 0;

export type LiveCaptionStartResult =
  | { ok: true }
  | { ok: false; message: string };

type StopRequest = {
  id: string;
  promise: Promise<CaptionSegment[]>;
};

function describeError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useLiveCaptions() {
  const [caption, setCaption] = useState(() => captionState(''));
  const [session, setSession] = useState(() => liveCaptionSession(''));
  const [timing, setTiming] = useState(captionTimingState);
  const sessionId = useRef<string | null>(null);
  const startedAt = useRef(0);
  const mounted = useRef(true);
  const transcript = useRef<CaptionSegment[]>([]);
  const stopRequest = useRef<StopRequest | null>(null);
  const acceptedSequence = useRef(-1);
  const finalized = useRef(new Set<string>());
  const loggedLines = useRef(0);

  const report = useMemo(() => captionTimingReport(timing), [timing]);

  /**
   * Record one stage observation on the session clock.
   *
   * Only `final-segment` and `speech-end` have a native source today: the
   * arrival of the revision that finalizes a segment, and that segment's own
   * end time.  `pause-detected` and `coverage-verdict` come from this lane's
   * endpointing and coverage passes through `noteCaptionTiming`, so nothing
   * here estimates a stage that was never observed.
   */
  const recordTiming = useCallback((utteranceId: string, stage: CaptionTimingStage, at: number) => {
    setTiming(previous => {
      try {
        return reduceCaptionTiming(previous, { utteranceId, stage, at: Math.max(0, Math.round(at)) });
      } catch (error) {
        console.warn(`caption-timing: rejected utterance=${utteranceId} stage=${stage} ${describeError(error, 'invalid event')}`);
        return previous;
      }
    });
  }, []);

  /** Report a stage the recognizer cannot observe, such as a coverage verdict. */
  const noteCaptionTiming = useCallback((utteranceId: string, stage: CaptionTimingStage, at?: number) => {
    if (!sessionId.current) return;
    recordTiming(utteranceId, stage, at ?? Date.now() - startedAt.current);
  }, [recordTiming]);

  const retainSegments = useCallback((segments: readonly CaptionSegment[]) => {
    transcript.current = mergeCaptionSegments(transcript.current, segments);
    const elapsed = Date.now() - startedAt.current;
    for (const segment of segments) {
      if (!segment?.isFinal || finalized.current.has(segment.id)) continue;
      finalized.current.add(segment.id);
      recordTiming(segment.id, 'speech-end', segment.t1 * 1_000);
      recordTiming(segment.id, 'final-segment', elapsed);
    }
  }, [recordTiming]);

  const fail = useCallback((id: string, message: string, reason?: string) => {
    setSession(previous => reduceLiveCaptionStatus(previous, {
      sessionId: id,
      status: 'error',
      message,
      reason,
    }));
  }, []);

  /**
   * Finish one native session exactly once.
   *
   * The session id stays live until the native promise settles. This lets the
   * final stop result win over unmount cleanup and keeps repeated stop calls
   * attached to the same native request.
   */
  const stopSession = useCallback((id: string): Promise<CaptionSegment[]> => {
    const existing = stopRequest.current;
    if (existing?.id === id) return existing.promise;

    if (!captions) {
      if (sessionId.current === id) sessionId.current = null;
      return Promise.resolve(transcript.current);
    }

    let promise: Promise<CaptionSegment[]>;
    promise = (async () => {
      try {
        const result = await captions.stop(id);
        if (sessionId.current === id && Array.isArray(result)) {
          transcript.current = [];
          retainSegments(result);
        }
        return transcript.current;
      } catch (error) {
        if (mounted.current && sessionId.current === id) {
          fail(id, describeError(error, 'Could not finish captions.'));
        }
        throw error;
      } finally {
        // Keep stopRequest so a second caller observes the same rejection or
        // result. A later start clears it after it has observed completion.
        if (sessionId.current === id) sessionId.current = null;
      }
    })();
    stopRequest.current = { id, promise };
    return promise;
  }, [fail, retainSegments]);

  useEffect(() => {
    mounted.current = true;
    const textListener = captions?.addListener('onCaption', update => {
      if (!mounted.current || update.sessionId !== sessionId.current || update.sequence <= acceptedSequence.current) return;
      acceptedSequence.current = update.sequence;
      if (Array.isArray(update.segments)) retainSegments(update.segments);
      setCaption(previous => reduceCaption(previous, update));
    });
    const statusListener = captions?.addListener('onStatus', update => {
      if (mounted.current && update.sessionId === sessionId.current) {
        setSession(previous => reduceLiveCaptionStatus(previous, update));
      }
    });
    return () => {
      mounted.current = false;
      textListener?.remove();
      statusListener?.remove();
      const id = sessionId.current;
      if (id) void stopSession(id).catch(() => {});
    };
  }, [retainSegments, stopSession]);

  // Pause detection, recognition finalization and coverage processing are
  // logged separately so a slow stage can be identified from a device log.
  useEffect(() => {
    for (const line of report.lines.slice(loggedLines.current)) console.log(line);
    loggedLines.current = report.lines.length;
  }, [report]);

  const start = useCallback(async (): Promise<LiveCaptionStartResult> => {
    // A new native run must not overlap an earlier stop. In normal camera use
    // this is already serialized by the recording state, but this also makes
    // retries and React cleanup safe.
    const previousId = sessionId.current;
    if (previousId) {
      try {
        await stopSession(previousId);
      } catch {
        // The new run can still be attempted. The failed run remains
        // recoverable through the caller's saved recording metadata.
      }
    }
    const previousStop = stopRequest.current;
    if (previousStop) {
      try {
        await previousStop.promise;
      } catch {
        // The rejection was already surfaced by stopSession.
      }
      if (stopRequest.current === previousStop) stopRequest.current = null;
    }

    const id = `${Date.now()}-${++nextSession}`;
    sessionId.current = id;
    startedAt.current = Date.now();
    setCaption(captionState(id));
    // A fresh session clears any earlier unavailable or interrupted state,
    // which is how an interruption recovers on the next start.
    setSession(liveCaptionSession(id));
    setTiming(captionTimingState());
    loggedLines.current = 0;
    transcript.current = [];
    acceptedSequence.current = -1;
    finalized.current.clear();

    if (!captions) {
      const message = 'Live captions require the Android development build.';
      sessionId.current = null;
      if (mounted.current) fail(id, message, 'unsupported-device');
      return { ok: false, message };
    }

    try {
      await captions.start(id);
      return { ok: true };
    } catch (error) {
      const message = describeError(error, 'Live captions unavailable.');
      // A rejected start can leave a partially initialized native session.
      // Drain it through the same idempotent stop path before returning.
      try {
        await stopSession(id);
      } catch {
        // Preserve the start error as the actionable message below.
      }
      if (mounted.current) fail(id, message);
      return { ok: false, message };
    }
  }, [fail, stopSession]);

  const stop = useCallback((): Promise<CaptionSegment[]> => {
    const id = sessionId.current;
    // A background transition or unmount may have already settled the native
    // request. Reuse that promise so a later recording callback still sees a
    // stop failure instead of treating the partial transcript as complete.
    if (!id) return stopRequest.current?.promise ?? Promise.resolve(transcript.current);
    return stopSession(id);
  }, [stopSession]);

  /**
   * Prepare recognition again after a recoverable failure.
   *
   * Preparation is only reachable through a native session start, so a retry
   * is a fresh session rather than a separate repair step. The recording that
   * is already running is untouched; only captions are re-attempted.
   */
  const retry = useCallback(() => start(), [start]);

  const status = timingAdjustedStatus(session.status, report);

  useEffect(() => {
    captionStatusStore.publish({
      status,
      reason: session.reason,
      message: session.message,
      retryable: session.retryable,
      retry,
      timing: report,
    });
  }, [report, retry, session.message, session.reason, session.retryable, status]);

  useEffect(() => () => captionStatusStore.reset(), []);

  return {
    text: caption.text,
    isFinal: caption.isFinal,
    status,
    reason: session.reason,
    message: session.message,
    retryable: session.retryable,
    timing: report,
    noteCaptionTiming,
    start,
    stop,
    retry,
    transcript,
  };
}

/**
 * Read-only recognition status for the capture lane.
 *
 * The camera route can call this without owning or starting a caption
 * session, and without the captions hook being lifted into shared state. It
 * reflects whichever mounted `useLiveCaptions()` is currently running, and
 * reports `idle` when none is.
 */
export function useCaptionStatusForCapture(): CaptureCaptionStatus {
  return useSyncExternalStore(
    captionStatusStore.subscribe,
    captionStatusStore.getSnapshot,
    captionStatusStore.getSnapshot,
  );
}
