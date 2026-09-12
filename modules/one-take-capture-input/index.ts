import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type CaptureInputNativeEvent = {
  command: 'advance' | 'scratch';
  source: 'native-key';
  eventId: number;
  generation: number;
};

type OneTakeCaptureInputEvents = {
  onInput(event: CaptureInputNativeEvent): void;
};

declare class OneTakeCaptureInputModule extends NativeModule<OneTakeCaptureInputEvents> {
  setCaptureActive(active: boolean): void;
}

const OneTakeCaptureInput: OneTakeCaptureInputModule | null =
  Platform.OS === 'android'
    ? (() => {
        try {
          return requireNativeModule<OneTakeCaptureInputModule>('OneTakeCaptureInput');
        } catch {
          return null;
        }
      })()
    : null;

export default OneTakeCaptureInput;
