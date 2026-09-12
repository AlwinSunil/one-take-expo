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
  selectNewTimingLines,
  streamElapsedMs,
  timingAdjustedStatus,
  type CaptionTimingStage,
} from '@/lib/caption-timing';
import {
  captionState,
  liveCaptionSession,
  mergeCaptionSegments,
  namespaceCaptionSegments,
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
  // Every stage timestamp is milliseconds on the audio-stream clock, whose
  // origin is the moment the native module reported `listening`. Segment end
  // times already use that clock; anchoring at `start()` instead would add the
  // whole preparation interval to pause detection.
  const streamStart = useRef<number | null>(null);
  const mounted = useRef(true);
  const transcript = useRef<CaptionSegment[]>([]);
  const stopRequest = useRef<StopRequest | null>(null);
  const acceptedSequence = useRef(-1);
  const finalized = useRef(new Set<string>());
  const loggedLines = useRef(new Set<string>());
  // Zero for the first attempt of a take; incremented by each retry so the
  // retried session's segment ids cannot overwrite what was already
  // recognized.
  const attempt = useRef(0);
  // Utterances recognized by earlier attempts of the take in progress. The
  // native stop result only describes the current session, so these are
  // re-merged rather than being replaced by it.
  const carried = useRef<CaptionSegment[]>([]);

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
  const recordTiming = useCallback((utteranceId: string, stage: CaptionTimingStage, at: number | null) => {
    if (at === null) return;
    let rejection: string | null = null;
    setTiming(previous => {
      try {
        return reduceCaptionTiming(previous, { utteranceId, stage, at: Math.max(0, Math.round(at)) });
      } catch (error) {
        // Reported outside the updater, which React may run twice.
        rejection = describeError(error, 'invalid event');
        return previous;
      }
    });
    if (rejection) console.warn(`caption-timing: rejected utterance=${utteranceId} stage=${stage} ${rejection}`);
  }, []);

  /**
   * Report a stage the recognizer cannot observe, such as a coverage verdict.
   *
   * `at` is milliseconds on the audio-stream clock. Omit it to use now.
   */
  const noteCaptionTiming = useCallback((utteranceId: string, stage: CaptionTimingStage, at?: number) => {
    if (!sessionId.current) return;
    recordTiming(utteranceId, stage, at ?? streamElapsedMs(Date.now(), streamStart.current));
  }, [recordTiming]);

  const retainSegments = useCallback((segments: readonly CaptionSegment[]) => {
    const owned = namespaceCaptionSegments(segments, attempt.current);
    transcript.current = mergeCaptionSegments(transcript.current, owned);
    const elapsed = streamElapsedMs(Date.now(), streamStart.current);
    for (const segment of owned) {
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
          transcript.current = carried.current;
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
        // The microphone stream exists from this point, so this is the origin
        // every stage timestamp is measured against.
        if (update.status === 'listening' && streamStart.current === null) streamStart.current = Date.now();
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
    // Selection is by line identity, not by count: utterances reach their
    // coverage verdict in a different order from the one they were first
    // observed in, so slicing would drop and repeat lines.
    for (const entry of selectNewTimingLines(report, loggedLines.current)) {
      loggedLines.current.add(entry.key);
      console.log(entry.line);
    }
  }, [report]);

  /**
   * Start one native caption session.
   *
   * `resume` keeps the transcript, timing and retry counter of the take in
   * progress. It is used by `retry()` after a mid-take failure, where the
   * video recording never stopped and the utterances already recognized must
   * survive into the saved project.
   */
  const start = useCallback(async (
    { resume = false }: { resume?: boolean } = {},
  ): Promise<LiveCaptionStartResult> => {
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
    streamStart.current = null;
    setCaption(captionState(id));
    // A fresh session clears any earlier unavailable or interrupted state,
    // which is how an interruption recovers on the next start.
    setSession(liveCaptionSession(id));
    acceptedSequence.current = -1;
    if (resume) {
      attempt.current += 1;
      carried.current = transcript.current;
    } else {
      attempt.current = 0;
      carried.current = [];
      setTiming(captionTimingState());
      loggedLines.current.clear();
      transcript.current = [];
      finalized.current.clear();
    }

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
  const retry = useCallback(() => start({ resume: true }), [start]);

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
