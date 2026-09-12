/** Match the decoded local path used by native file APIs, including URI aliases. */
export function localFileIdentity(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return null;
    const parts: string[] = [];
    for (const part of decodeURIComponent(url.pathname).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { parts.pop(); continue; }
      if (part.includes('\0') || part.includes('\\')) return null;
      parts.push(part);
    }
    return `file:///${parts.map(encodeURIComponent).join('/')}`;
  } catch { return null; }
}

export function isWithinFileRoots(uri: string, roots: readonly string[]): boolean {
  const file = localFileIdentity(uri);
  return !!file && roots.some(root => {
    const directory = localFileIdentity(root);
    return !!directory && file.startsWith(`${directory}/`);
  });
}

/** A failed cancellation must not release deletion while another writer is still settling. */
export async function settleProjectCancellation(callbacks: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(callbacks.map(cancel => Promise.resolve().then(cancel)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
