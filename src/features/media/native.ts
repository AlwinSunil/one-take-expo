import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { Platform, type ViewProps } from 'react-native';
import type { ComponentType } from 'react';

export interface MediaSegment {
  uri: string;
  start: number;
  end: number;
  caption?: string;
  crop?: { left: number; right: number; bottom: number; top: number };
  takeId?: string;
}
export interface ExportJob {
  id: string;
  projectId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  uri?: string;
  galleryUri?: string;
  error?: string;
  segments: MediaSegment[];
}
interface NativeMedia {
  inspectSource?(uri: string): Promise<string>;
  inspectExport?(id: string): Promise<string>;
  startExport(projectId: string, segments: string): Promise<string>;
  getJobs(projectId: string): Promise<string>;
  cancelExport(id: string): Promise<void>;
  deleteProjectExports(projectId: string): Promise<void>;
  saveToGallery(id: string): Promise<string>;
  shareExport(id: string): Promise<void>;
}
export const nativeMedia = Platform.OS === 'android' ? requireOptionalNativeModule<NativeMedia>('OneTakeMediaResearch') : null;
export const NativeCutView = nativeMedia ? requireNativeViewManager('OneTakeMediaResearch') as ComponentType<ViewProps & {
  segments: string;
  playing: boolean;
  seek: number;
  onState: (event: { nativeEvent: { ready?: boolean; ended?: boolean; playing?: boolean; position?: number; duration?: number; firstFrameMs?: number; error?: string } }) => void;
}> : null;
export async function getExportJobs(projectId: string): Promise<ExportJob[]> {
  return nativeMedia ? JSON.parse(await nativeMedia.getJobs(projectId)) : [];
}
