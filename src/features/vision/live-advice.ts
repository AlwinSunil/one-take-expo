import { useEffect, useRef, useState } from 'react';
import type { VisionEvidence } from './state';
type AdviceKind = 'face' | 'bright' | 'dark' | 'frame';
type FeedbackKind = AdviceKind | 'clear' | 'measuring' | 'unavailable';
const MESSAGES: Record<AdviceKind, string> = {
  face: 'Face out of view. Move into frame.',
  bright: 'Harsh light on your face. Try softer light.',
  dark: 'Your face looks too dark. Try more light.',
  frame: 'Move back a little to keep your face in frame.',
};
function adviceKind(evidence: VisionEvidence, current: AdviceKind | null = null): AdviceKind | null {
  if (evidence.status !== 'ready' || !evidence.faceStable) return null;
  if (evidence.facePresence === 'absent') return 'face';
  if (evidence.facePresence !== 'present') return null;
  const exposure = evidence.exposure;
  const measured = exposure && [exposure.mean, exposure.clipped, exposure.dark].every(value => Number.isFinite(value) && value >= 0 && value <= 1) && exposure.clipped + exposure.dark <= 1.01;
  if (measured && exposure.clipped > (current === 'bright' ? 0.10 : 0.18)) return 'bright';
  if (measured && exposure.mean < (current === 'dark' ? 0.22 : 0.16) && exposure.dark > (current === 'dark' ? 0.4 : 0.6)) return 'dark';
  const faces = evidence.faces.filter(face => [face.left, face.right, face.top, face.bottom].every(Number.isFinite) && face.right > face.left && face.bottom > face.top);
  const face = faces.reduce<(typeof faces)[number] | undefined>((largest, current) =>
    !largest || (current.right - current.left) * (current.bottom - current.top) > (largest.right - largest.left) * (largest.bottom - largest.top) ? current : largest, undefined);
  const inset = current === 'frame' ? 0.06 : 0.02;
  if (face && (face.left < inset || face.right > 1-inset || face.top < inset || face.bottom > 1-inset)) return 'frame';
  return null;
}
export function visualAdvice(evidence: VisionEvidence): string | null {
  const kind = adviceKind(evidence);
  return kind ? MESSAGES[kind] : null;
}
export interface VisualAdviceState { current: FeedbackKind | null; pending: FeedbackKind | null; since: number; shownAt: number; lastReadyAt: number; identity: string }
export function emptyVisualAdvice(): VisualAdviceState { return { current: null, pending: null, since: 0, shownAt: 0, lastReadyAt: 0, identity: '' }; }
export function advanceVisualAdvice(previous: VisualAdviceState, evidence: VisionEvidence, enabled: boolean, now: number): VisualAdviceState {
  if (!enabled || !Number.isFinite(now)) return emptyVisualAdvice();
  const identity = `${evidence.sessionId}:${evidence.lensFacing}`;
  if (evidence.status !== 'ready') {
    // Brief frame delays affect evidence validity, not the readability of the last displayed hint.
    if (evidence.status === 'unavailable' && evidence.reason === 'stale-frame'
      && previous.identity === identity && now >= previous.lastReadyAt && now - previous.lastReadyAt < 2000) {
      return previous;
    }
    if (evidence.status === 'pending') return { ...emptyVisualAdvice(), identity };
    return previous.current === 'unavailable' && previous.identity === identity ? previous
      : { ...emptyVisualAdvice(), identity, current: 'unavailable', shownAt: now };
  }
  const state = { ...(previous.identity === identity ? previous : { ...emptyVisualAdvice(), identity }), lastReadyAt: now };
  const warning = state.current && state.current in MESSAGES ? state.current as AdviceKind : null;
  const exposure = evidence.exposure;
  const measured = exposure && [exposure.mean, exposure.clipped, exposure.dark].every(value => Number.isFinite(value) && value >= 0 && value <= 1) && exposure.clipped + exposure.dark <= 1.01;
  const next: FeedbackKind | null = !evidence.faceStable || evidence.facePresence === 'unknown' ? null
    : adviceKind(evidence, warning) ?? (measured ? 'clear' : 'measuring');
  if (next === state.current) return { ...state, pending: next, since: now };
  if (next !== state.pending || now < state.since) return { ...state, pending: next, since: now };
  const delay = next === null ? 1500 : 2000;
  const readable = state.current === null || now - state.shownAt >= 4500;
  return readable && now-state.since >= delay ? { ...state, current: next, since: now, shownAt: now } : state;
}
export function visualFeedback(state: VisualAdviceState) {
  const advice = state.current && state.current in MESSAGES ? MESSAGES[state.current as AdviceKind] : null;
  const summary = advice ?? (state.current === 'clear' ? 'Lighting and framing look good.'
    : state.current === 'measuring' ? 'Face detected. Lighting measurement is unavailable.'
      : state.current === 'unavailable' ? 'Camera analysis paused. Keep the camera open or retry.'
        : 'Checking lighting and framing…');
  return { advice, summary };
}
export function useVisualFeedback(evidence: VisionEvidence, enabled: boolean) {
  const [feedback, setFeedback] = useState(() => visualFeedback(emptyVisualAdvice()));
  const state = useRef(emptyVisualAdvice());
  useEffect(() => {
    const update = () => {
      state.current = advanceVisualAdvice(state.current, evidence, enabled, Date.now());
      const next = visualFeedback(state.current);
      setFeedback(previous => previous.advice === next.advice && previous.summary === next.summary ? previous : next);
    };
    update();
    if (!enabled) return;
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [evidence, enabled]);
  return feedback;
}
