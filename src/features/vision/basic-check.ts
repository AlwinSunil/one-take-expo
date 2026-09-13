import type { VisionEvidence } from './state';

export interface BasicVisualCheck {
  status: 'unavailable' | 'observed';
  message: string;
  observedAtMs?: number;
}

/** Tap-only description of existing face boxes, not calibrated composition advice. */
export function basicVisualCheck(evidence: VisionEvidence, nowMs: number): BasicVisualCheck {
  const unavailable = (message: string): BasicVisualCheck => ({ status: 'unavailable', message });
  if (evidence.status !== 'ready') return unavailable(evidence.status === 'pending'
    ? 'The face detector is warming up. Hold the camera steady and check again.'
    : 'Face detection is unavailable right now. Keep recording or check again when the camera is ready.');
  const age = nowMs - evidence.frameCapturedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > 500) return unavailable('The camera snapshot is out of date. Hold steady and check again.');
  if (evidence.facePresence === 'unknown') return unavailable('The detector could not confirm a face. Check the view yourself and try again.');
  const faces = evidence.faces;
  if (faces.some(face => ![face.left, face.top, face.right, face.bottom].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || face.right <= face.left || face.bottom <= face.top)) return unavailable('Face position could not be read. Check again.');
  const observed = (message: string): BasicVisualCheck => ({ status: 'observed', message, observedAtMs: evidence.frameCapturedAtMs });
  if (evidence.facePresence === 'absent' && faces.length === 0) return observed('No face detected in this snapshot. For a talking-head shot, bring your face into view. For a product shot, a face is optional.');
  if (evidence.facePresence !== 'present' || faces.length === 0) return unavailable('Face position is uncertain. Hold steady and check again.');
  if (faces.length > 1) return observed(`${faces.length} faces detected. Check that everyone you want in the shot is visible; no person has been selected automatically.`);
  const face = faces[0];
  // These margins describe an approximate detector box in the analyzed frame.
  // They do not certify the preview crop, hair/head boundary or image quality.
  if (face.left < 0.04 || face.top < 0.04 || face.right > 0.96 || face.bottom > 0.96) {
    return observed('One face detected close to an edge of the analyzed frame. Consider leaving more room and check the preview before recording.');
  }
  return observed('One face detected with space around its detected box. Check the preview for your preferred framing.');
}
