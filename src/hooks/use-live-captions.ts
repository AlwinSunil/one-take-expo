import { useCallback, useEffect, useRef, useState } from 'react';

import captions, { type CaptionSegment } from '../../modules/one-take-captions';
import { captionState, reduceCaption } from '@/lib/live-caption-state';

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
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const session = useRef<string | null>(null);
  const mounted = useRef(true);
  const transcript = useRef<CaptionSegment[]>([]);
  const stopRequest = useRef<StopRequest | null>(null);
  const acceptedSequence = useRef(-1);
  const segmentHistory = useRef(new Map<string, CaptionSegment>());

  function retainSegments(segments: readonly CaptionSegment[]) {
    for (const segment of segments) {
      if (typeof segment.id === 'string' && segment.id.length > 0) {
        // Events are accepted in sequence order, so a later occurrence of an
        // id is the latest revision of that utterance, including its finality
        // and timing.
        segmentHistory.current.set(segment.id, segment);
      }
    }
    transcript.current = [...segmentHistory.current.values()].sort((a, b) =>
      a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id));
  }

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
      if (session.current === id) session.current = null;
      return Promise.resolve(transcript.current);
    }

    let promise: Promise<CaptionSegment[]>;
    promise = (async () => {
      try {
        const result = await captions.stop(id);
        if (session.current === id && Array.isArray(result)) {
          segmentHistory.current.clear();
          retainSegments(result);
        }
        return transcript.current;
      } catch (error) {
        if (mounted.current && session.current === id) {
          setStatus('error');
          setMessage(describeError(error, 'Could not finish captions.'));
        }
        throw error;
      } finally {
        // Keep stopRequest so a second caller observes the same rejection or
        // result. A later start clears it after it has observed completion.
        if (session.current === id) session.current = null;
      }
    })();
    stopRequest.current = { id, promise };
    return promise;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const textListener = captions?.addListener('onCaption', update => {
      if (!mounted.current || update.sessionId !== session.current || update.sequence <= acceptedSequence.current) return;
      acceptedSequence.current = update.sequence;
      if (Array.isArray(update.segments)) retainSegments(update.segments);
      setCaption(previous => reduceCaption(previous, update));
    });
    const statusListener = captions?.addListener('onStatus', update => {
      if (mounted.current && update.sessionId === session.current) {
        setStatus(previous => previous === 'error' && update.status === 'stopped' ? previous : update.status);
        if (update.message) setMessage(update.message);
      }
    });
    return () => {
      mounted.current = false;
      textListener?.remove();
      statusListener?.remove();
      const id = session.current;
      if (id) void stopSession(id).catch(() => {});
    };
  }, [stopSession]);

  const start = useCallback(async (): Promise<LiveCaptionStartResult> => {
    // A new native run must not overlap an earlier stop. In normal camera use
    // this is already serialized by the recording state, but this also makes
    // retries and React cleanup safe.
    const previousId = session.current;
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
    session.current = id;
    setCaption(captionState(id));
    setMessage('');
    setStatus('preparing');
    transcript.current = [];
    acceptedSequence.current = -1;
    segmentHistory.current.clear();

    if (!captions) {
      const message = 'Live captions require the Android development build.';
      session.current = null;
      if (mounted.current) {
        setStatus('error');
        setMessage(message);
      }
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
      if (mounted.current) {
        setStatus('error');
        setMessage(message);
      }
      return { ok: false, message };
    }
  }, [stopSession]);

  const stop = useCallback((): Promise<CaptionSegment[]> => {
    const id = session.current;
    // A background transition or unmount may have already settled the native
    // request. Reuse that promise so a later recording callback still sees a
    // stop failure instead of treating the partial transcript as complete.
    if (!id) return stopRequest.current?.promise ?? Promise.resolve(transcript.current);
    return stopSession(id);
  }, [stopSession]);

  return { text: caption.text, isFinal: caption.isFinal, status, message, start, stop, transcript };
}
