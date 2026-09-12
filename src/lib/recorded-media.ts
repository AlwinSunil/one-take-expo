import media from '../../modules/one-take-media';

export async function recordedMediaDuration(uri: string): Promise<number> {
  if (typeof media?.getMediaInfo !== 'function') {
    throw new Error('This build cannot verify saved video duration. Keep this original and update the app before saving or previewing its cuts.');
  }
  const { duration } = await media.getMediaInfo(uri);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The saved video has no readable duration. The original has been retained.');
  return duration;
}
