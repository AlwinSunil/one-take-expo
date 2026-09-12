import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type MediaCut = {
  /** Start in seconds relative to the original source. */
  t0: number;
  /** End in seconds relative to the original source. */
  t1: number;
};

export type MediaCaption = MediaCut & {
  text: string;
};

export type MediaExportRequest = {
  id: string;
  sourceUri: string;
  cuts: MediaCut[];
  captions: MediaCaption[];
};

export type MediaExportStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export type MediaExport = {
  id: string;
  status: MediaExportStatus;
  progress: number;
  uri?: string;
  error?: string;
};

export declare class OneTakeMediaModule extends NativeModule {
  startExport(request: MediaExportRequest): Promise<{ id: string }>;
  getExport(id: string): Promise<MediaExport>;
  cancelExport(id: string): Promise<void>;
  saveToGallery(id: string): Promise<string>;
  shareExport(id: string): Promise<void>;
}

/**
 * Media export is Android-only. Keep the lookup lazy and nullable so the
 * review screen can still render on web, iOS, Expo Go, and older builds that
 * have not included the native module yet.
 */
const OneTakeMedia: OneTakeMediaModule | null =
  Platform.OS === 'android'
    ? (() => {
        try {
          return requireNativeModule<OneTakeMediaModule>('OneTakeMedia');
        } catch {
          return null;
        }
      })()
    : null;

export default OneTakeMedia;
