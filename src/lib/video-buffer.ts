import type { BufferOptions } from 'expo-video';

// Local recordings do not need the default ~128 MB video allocation per player.
// A thumbnail player and preview can coexist briefly during the recording handoff.
export const LOCAL_VIDEO_BUFFER: BufferOptions = {
  preferredForwardBufferDuration: 3,
  minBufferForPlayback: 0.25,
  maxBufferBytes: 16 * 1024 * 1024,
  prioritizeTimeOverSizeThreshold: false,
};
