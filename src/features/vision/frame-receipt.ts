import type { VisionFrameEvent } from '../../../modules/one-take-vision';
import { reduceVisionEvent, type VisionState } from './state.ts';

/** Native and JS monotonic clocks have different origins; freshness uses the receipt's clock snapshot. */
export function receiveVisionFrame(state: VisionState, event: VisionFrameEvent, offset: number | null, receivedAtMs: number) {
  const clockOffsetMs = offset ?? receivedAtMs - event.frameEmittedAtMs;
  const next = reduceVisionEvent(state, {
    type: 'frame', sessionId: event.sessionId, lensFacing: event.lensFacing,
    frameId: event.frameId, frameCapturedAtMs: event.frameCapturedAtMs + clockOffsetMs,
    facePresent: event.facePresent, stable: event.stable, faces: event.faces, exposure: event.exposure,
  }, receivedAtMs);
  return { state: next, nowMs: receivedAtMs, clockOffsetMs };
}
