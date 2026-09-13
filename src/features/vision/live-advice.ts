import { useEffect, useRef, useState } from 'react';
import type { VisionEvidence } from './state';
type AdviceKind = 'face' | 'bright' | 'dark' | 'frame';
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
export interface VisualAdviceState { current: AdviceKind | null; pending: AdviceKind | null; since: number; shownAt: number; identity: string }
export function emptyVisualAdvice(): VisualAdviceState { return { current: null, pending: null, since: 0, shownAt: 0, identity: '' }; }
export function advanceVisualAdvice(previous: VisualAdviceState, evidence: VisionEvidence, enabled: boolean, now: number): VisualAdviceState {
  if (!enabled || evidence.status !== 'ready' || !Number.isFinite(now)) return emptyVisualAdvice();
  const identity = `${evidence.sessionId}:${evidence.lensFacing}`;
  const state = previous.identity === identity ? previous : { ...emptyVisualAdvice(), identity };
  const next = adviceKind(evidence, state.current);
  if (next === state.current) return { ...state, pending: next, since: now };
  if (next !== state.pending || now < state.since) return { ...state, pending: next, since: now };
  const delay = next === null ? 1500 : 2000;
  const readable = state.current === null || now - state.shownAt >= 4500;
  return readable && now-state.since >= delay ? { ...state, current: next, since: now, shownAt: now } : state;
}
export function useLiveVisualAdvice(evidence: VisionEvidence, enabled: boolean) {
  const [message, setMessage] = useState<string | null>(null);
  const state = useRef(emptyVisualAdvice());
  useEffect(() => {
    const update = () => {
      state.current = advanceVisualAdvice(state.current, evidence, enabled, Date.now());
      setMessage(state.current.current ? MESSAGES[state.current.current] : null);
    };
    update();
    if (!enabled) return;
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [evidence, enabled]);
  return message;
}

export function visualSuggestionSummary(evidence: VisionEvidence, advice: string | null): string {
  if (evidence.status === 'unavailable') return 'Lighting and framing checks are unavailable. Reopen the camera to retry.';
  if (evidence.status !== 'ready') return 'Checking lighting and framing…';
  if (advice) return advice;
  // The panel shares the settled hint; raw frame results bypass its reading time.
  if (!evidence.faceStable || evidence.facePresence === 'unknown') return 'Watching lighting and framing. Suggestions appear here.';
  if (!evidence.exposure || ![evidence.exposure.mean, evidence.exposure.clipped, evidence.exposure.dark].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || evidence.exposure.clipped + evidence.exposure.dark > 1.01) return 'Framing checked. Still measuring lighting…';
  return 'Watching lighting and framing. Suggestions appear here.';
}
