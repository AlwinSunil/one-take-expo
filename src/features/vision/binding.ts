/** A native start may finish after cleanup has already attempted to stop it. */
export async function startVisionBinding<T>(
  start: () => Promise<T>,
  isCurrent: () => boolean,
  stop: () => Promise<void>,
): Promise<T | null> {
  const result = await start();
  if (isCurrent()) return result;
  // A binding-specific stop cannot stop the subsequent camera owner.
  await stop().catch(() => undefined);
  return null;
}
