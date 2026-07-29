// Small IndexedDB wrapper for heavy binary blobs (voiceover audio, frame images).
// Keeps localStorage under quota by moving multi-MB payloads out of JSON.
//
// Storage shape:
//   DB "foundry" v1, object store "blobs" keyed by string ref.
//   Values are { blob: Blob, mimeType: string, createdAt: number }.
//
// Consumers store only the string ref inside project JSON. A tiny in-memory
// mirror keeps sync reads instant after the initial async warm-up.

const DB_NAME = "foundry";
const DB_VERSION = 1;
const STORE = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no indexedDB"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export type StoredBlob = { blob: Blob; mimeType: string; createdAt: number };

export function putBlob(ref: string, blob: Blob, mimeType: string): Promise<void> {
  return tx("readwrite", (s) =>
    s.put({ blob, mimeType, createdAt: Date.now() } satisfies StoredBlob, ref),
  ).then(() => undefined);
}

export function getBlob(ref: string): Promise<StoredBlob | undefined> {
  return tx<StoredBlob | undefined>("readonly", (s) => s.get(ref) as IDBRequest<StoredBlob | undefined>);
}

export function deleteBlob(ref: string): Promise<void> {
  return tx("readwrite", (s) => s.delete(ref)).then(() => undefined);
}

export function listRefs(): Promise<string[]> {
  return tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((keys) =>
    keys.map((k) => String(k)),
  );
}

/** Delete every ref not in the keep set. Fire-and-forget garbage collection. */
export async function gc(keep: Set<string>): Promise<void> {
  try {
    const all = await listRefs();
    await Promise.all(all.filter((r) => !keep.has(r)).map((r) => deleteBlob(r).catch(() => {})));
  } catch {
    /* ignore */
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return base64ToBlob(m[2], m[1]);
}

export function newRef(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}
