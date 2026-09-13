import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type VisionLensFacing = 'front' | 'back';
export type VisionEngine = 'mlkit-face' | 'none' | 'unknown';
export type VisionProcessor = 'cpu-fallback' | 'npu' | 'unknown';

export type VisionUnavailableReason =
  | 'model-loading'
  | 'no-frame-pipeline'
  | 'model-error'
  | 'runtime-unavailable'
  | 'unsupported-device'
  | 'thermal-pressure'
  | 'stale-frame'
  | 'camera-binding-failed'
  | 'activity-unavailable'
  | 'permission'
  | 'unknown';

export type VisionFace = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  trackingId?: number | null;
};

export type VisionStatus = 'pending' | 'ready' | 'unavailable' | 'stopped';

export type VisionStatusEvent = {
  sessionId: string;
  lensFacing: VisionLensFacing;
  status: VisionStatus;
  reason?: VisionUnavailableReason;
  engine: VisionEngine;
  processor: VisionProcessor;
  model?: string;
  npuStatus?: 'unavailable' | 'not-evaluated';
  npuUnavailableReason?: string;
  device?: VisionDeviceStatus;
};

export type VisionFrameEvent = {
  exposure?: { mean: number; clipped: number; dark: number };
  sessionId: string;
  lensFacing: VisionLensFacing;
  frameId: number;
  /** Elapsed-realtime milliseconds from the Android frame producer. */
  frameCapturedAtMs: number;
  /** Elapsed-realtime emission clock used to normalize the JS bridge clock. */
  frameEmittedAtMs: number;
  facePresent: boolean | null;
  stable: boolean;
  stableForMs: number;
  faces: readonly VisionFace[];
  thermalStatus?: VisionThermalStatus;
  droppedFrames?: number;
  inferenceMs?: number;
};

export type VisionDeviceStatus = {
  batteryPercent: number | null;
  charging: boolean | null;
  batteryState: 'charging' | 'full' | 'discharging' | 'unknown';
  thermalStatus: VisionThermalStatus;
  thermalSeverity: number | null;
  cameraAvailable: boolean;
  cameraPermissionGranted: boolean;
  microphoneAvailable: boolean;
  microphonePermissionGranted: boolean;
  capturedAtMs: number;
};

export type VisionThermalStatus =
  | 'none'
  | 'light'
  | 'moderate'
  | 'severe'
  | 'critical'
  | 'emergency'
  | 'shutdown'
  | 'unknown';

export type VisionStartResult = {
  status: 'started' | 'unavailable';
  sessionId: string;
  lensFacing: VisionLensFacing;
  engine: VisionEngine;
  processor: VisionProcessor;
  reason?: VisionUnavailableReason;
};

export type VisionDiagnostics = {
  enabled: boolean;
  reason?: 'debug-only';
  moduleVersion?: string;
  model?: string;
  engine?: VisionEngine;
  processor?: VisionProcessor;
  npuStatus?: 'unavailable' | 'not-evaluated';
  npuUnavailableReason?: string;
  sessionId?: string | null;
  lensFacing?: VisionLensFacing | null;
  framesReceived?: number;
  framesProcessed?: number;
  framesDropped?: number;
  detectorSuccesses?: number;
  detectorFailures?: number;
  lastInferenceMs?: number | null;
  medianInferenceMs?: number | null;
  p95InferenceMs?: number | null;
  thermalStatus?: VisionThermalStatus;
  buildConfig?: string;
  appVersion?: string;
};

export type OneTakeVisionEvents = {
  onVisionStatus(event: VisionStatusEvent): void;
  onVisionFrame(event: VisionFrameEvent): void;
};

export declare class OneTakeVisionModule extends NativeModule<OneTakeVisionEvents> {
  /**
   * Starts optional analysis after the existing CameraView emits onCameraReady.
   * The native module binds one ImageAnalysis use case to CameraX's existing
   * ProcessCameraProvider; it never creates or controls a recorder.
   */
  start(sessionId: string, lensFacing: VisionLensFacing): Promise<VisionStartResult>;
  stop(sessionId: string): Promise<void>;
  getDeviceStatus(): Promise<VisionDeviceStatus>;
  getDiagnostics(): Promise<VisionDiagnostics>;
}

/**
 * Vision is optional. Keep imports safe on web, iOS and builds where the
 * Android module has not been installed yet.
 */
const OneTakeVision: OneTakeVisionModule | null =
  Platform.OS === 'android'
    ? (() => {
        try {
          return requireNativeModule<OneTakeVisionModule>('OneTakeVision');
        } catch {
          return null;
        }
      })()
    : null;

export default OneTakeVision;
