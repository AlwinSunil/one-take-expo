/** A native start may finish after cleanup has already attempted to stop it. */
export async function startVisionBinding<T>(
  start: () => Promise<T>,
  isCurrent: () => boolean,
  stop: () => Promise<void>,
): Promise<T | null> {
  let result: T;
  try {
    result = await start();
  } catch (error) {
    // A bridge rejection may occur after native work partially attached.
    await stop().catch(() => undefined);
    throw error;
  }
  if (isCurrent()) return result;
  // A binding-specific stop cannot stop the subsequent camera owner.
  await stop().catch(() => undefined);
  return null;
}
