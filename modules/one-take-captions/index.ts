import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type CaptionStatus =
  | 'preparing'
  | 'listening'
  | 'delayed'
  | 'stopping'
  | 'stopped'
  | 'error';

export type CaptionEvent = {
  sessionId: string;
  text: string;
  isFinal: boolean;
  sequence: number;
  segments?: CaptionSegment[];
};

export type CaptionSegment = { id: string; t0: number; t1: number; text: string; isFinal: boolean };

export type CaptionStatusEvent = {
  sessionId: string;
  status: CaptionStatus;
  message?: string;
};

export type OneTakeCaptionsEvents = {
  onCaption(event: CaptionEvent): void;
  onStatus(event: CaptionStatusEvent): void;
  onRefinement(event: { id: string; progress: number; status: string; quietIntervals?: { t0: number; t1: number }[] }): void;
};

export declare class OneTakeCaptionsModule extends NativeModule<OneTakeCaptionsEvents> {
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<CaptionSegment[]>;
  refine(id: string, sourceUri: string, model: 'tiny' | 'small'): Promise<CaptionSegment[]>;
  cancelRefinement(id: string): Promise<void>;
}

/**
 * The module is Android-only. Keeping this lookup lazy lets the camera screen
 * render on web/iOS and lets callers treat an unsupported native build as a
 * captions-unavailable capability.
 */
const OneTakeCaptions: OneTakeCaptionsModule | null =
  Platform.OS === 'android'
    ? (() => {
        try {
          return requireNativeModule<OneTakeCaptionsModule>('OneTakeCaptions');
        } catch {
          return null;
        }
      })()
    : null;

export default OneTakeCaptions;
