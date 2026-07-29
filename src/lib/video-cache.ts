// Session-only cache for source video blobs. Lets the frames pipeline reuse
// one download across many product timestamp captures — 1 fetch, N cheap
// canvas seeks. Cleared automatically on tab close; never persisted.

const cache = new Map<string, { blob: Blob; objectUrl: string }>();

export function getCachedVideo(key: string): { blob: Blob; objectUrl: string } | null {
  return cache.get(key) ?? null;
}

export function setCachedVideo(key: string, blob: Blob): { blob: Blob; objectUrl: string } {
  const prev = cache.get(key);
  if (prev) {
    try { URL.revokeObjectURL(prev.objectUrl); } catch { /* ignore */ }
  }
  const objectUrl = URL.createObjectURL(blob);
  const entry = { blob, objectUrl };
  cache.set(key, entry);
  return entry;
}

export function clearCachedVideo(key: string) {
  const prev = cache.get(key);
  if (!prev) return;
  try { URL.revokeObjectURL(prev.objectUrl); } catch { /* ignore */ }
  cache.delete(key);
}
