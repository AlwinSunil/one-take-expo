import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Why recognition stopped producing text.
 *
 * These names are the wire contract with `CaptionFailureReason.kt`; the app
 * imports them from here rather than the other way round.
 */
export type CaptionUnavailableReason =
  | 'model-missing'
  | 'model-corrupt'
  | 'initialization-failed'
  | 'unsupported-device'
  | 'permission-denied'
  | 'unknown';

/** A failure the take survives, which the next start clears on its own. */
export type CaptionInterruptionReason =
  | 'audio-focus-lost'
  | 'audio-route-changed'
  | 'lifecycle-interrupted';

export type CaptionFailureReason = CaptionUnavailableReason | CaptionInterruptionReason;

/**
 * The wire status vocabulary emitted by the Kotlin module.
 *
 * `error` means recognition stopped being able to produce text; the paired
 * `reason` says why and whether another attempt can help.  `interrupted` is
 * separate because the take itself is still usable and the next start
 * recovers without any user action.
 */
export type CaptionStatus =
  | 'preparing'
  | 'listening'
  | 'delayed'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
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
  /**
   * A `CaptionFailureReason` when the native module could name the failure.
   * Typed as a plain string because an older installed native build may not
   * send one, and a newer one may send a reason this JavaScript does not know
   * yet; `classifyCaptionFailure` resolves both cases.
   */
  reason?: string;
  processor?: string;
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
