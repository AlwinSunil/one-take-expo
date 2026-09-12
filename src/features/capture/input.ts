import { Platform } from 'react-native';
import captureInput, { type CaptureInputNativeEvent } from '../../../modules/one-take-capture-input';

import type { CaptureCommand, CaptureInputEvent } from './capture-controls';

const nativeCaptureInput = Platform.OS === 'android' ? captureInput : null;

/** Enable Android key events only while the route owns an active take. */
export function setCaptureInputActive(active: boolean): void {
  nativeCaptureInput?.setCaptureActive(active);
}

/**
 * Subscribe to one native input stream. The event is validated again at the
 * JS gate because queued native events can outlive the take that created them.
 */
export function subscribeCaptureInput(listener: (event: CaptureInputEvent) => void): () => void {
  if (!nativeCaptureInput) return () => {};
  const subscription = nativeCaptureInput.addListener('onInput', (value: CaptureInputNativeEvent) => {
    if (!Number.isInteger(value.eventId) || !Number.isInteger(value.generation)) return;
    listener({
      command: value.command,
      source: 'native-key',
      eventId: value.eventId,
      generation: value.generation,
    });
  });
  return () => subscription.remove();
}
