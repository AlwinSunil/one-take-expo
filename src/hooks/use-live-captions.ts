import { useCallback, useEffect, useRef, useState } from 'react';

import captions from '../../modules/one-take-captions';
import { captionState, reduceCaption } from '@/lib/live-caption-state';

let nextSession = 0;

export function useLiveCaptions() {
  const [caption, setCaption] = useState(() => captionState(''));
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const session = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const textListener = captions?.addListener('onCaption', update => {
      if (mounted.current && update.sessionId === session.current) {
        setCaption(previous => reduceCaption(previous, update));
      }
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
      session.current = null;
      if (id) void captions?.stop(id).catch(() => {});
    };
  }, []);

  const start = useCallback(async () => {
    const id = `${Date.now()}-${++nextSession}`;
    session.current = id;
    setCaption(captionState(id));
    setMessage('');
    setStatus('preparing');
    try {
      if (!captions) throw new Error('Live captions require the Android development build.');
      await captions.start(id);
    } catch (error) {
      if (mounted.current && session.current === id) {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Live captions unavailable.');
      }
    }
  }, []);

  const stop = useCallback(async () => {
    const id = session.current;
    if (!id || !captions) return;
    try {
      await captions.stop(id);
    } catch (error) {
      if (mounted.current && session.current === id) {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Could not finish captions.');
      }
    }
  }, []);

  return { text: caption.text, status, message, start, stop };
}
