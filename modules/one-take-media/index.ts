import { NativeModule, requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';

export type MediaCut = {
  /** Start in seconds relative to the original source. */
  t0: number;
  /** End in seconds relative to the original source. */
  t1: number;
};

export type MediaCaption = MediaCut & {
  text: string;
};

/** Media3 centered normalized device coordinates for one source segment. */
export type NativeFramingCrop = {
  /** Left edge, in [-1, 1]. */
  left: number;
  /** Right edge, in [-1, 1] and greater than left. */
  right: number;
  /** Bottom edge, in [-1, 1]. */
  bottom: number;
  /** Top edge, in [-1, 1] and greater than bottom. */
  top: number;
};

export type MediaSourceSegment = {
  uri: string;
  t0: number;
  t1: number;
  captions?: MediaCaption[];
  takeId?: string;
  /** Optional validated crop. Omit to preserve the original frame. */
  crop?: NativeFramingCrop;
};

export type MediaExportRequest = {
  id: string;
  sourceUri: string;
  cuts: MediaCut[];
  captions: MediaCaption[];
  segments?: MediaSourceSegment[];
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
  galleryUri?: string;
  error?: string;
};

export type MediaInfo = { duration: number; width: number; height: number };

export declare class OneTakeMediaModule extends NativeModule {
  /** True only in native builds that apply segment crops to preview and export. */
  readonly supportsFraming?: boolean;
  /** Encoded duration in seconds and display-oriented dimensions; absent on older builds. */
  getMediaInfo?: (uri: string) => Promise<MediaInfo>;
  startExport(request: MediaExportRequest): Promise<{ id: string }>;
  getExport(id: string): Promise<MediaExport>;
  cancelExport(id: string): Promise<void>;
  deleteExport(id: string, deleteGallery: boolean): Promise<void>;
  openExport(id: string): Promise<void>;
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

export const NativeCutPreview = OneTakeMedia ? requireNativeViewManager('OneTakeMedia') as ComponentType<ViewProps & {
  request: string;
  playing: boolean;
  seek: number;
  onState: (event: { nativeEvent: { ready?: boolean; ended?: boolean; playing?: boolean; position?: number; duration?: number; firstFrameMs?: number; error?: string } }) => void;
}> : null;
