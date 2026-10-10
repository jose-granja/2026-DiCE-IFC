/**
 * Origin Private File System store.
 *
 * OPFS is a per-origin sandbox: no other site can read it, no server can read
 * it, and it survives a reload. That makes it the right home for the things the
 * app must remember between sessions but must never upload — parsed-model
 * caches, IDS drafts, BCF working copies, workspace layouts.
 *
 * Clearing site data wipes all of it. That is the intended escape hatch and the
 * `/privacy` page says so.
 *
 * Everything here is namespaced under a top-level directory per kind, so
 * "forget all IDS drafts" is one call and cannot take a BCF file with it.
 */

export const OPFS_NAMESPACES = {
  models: "models",
  workspaces: "workspaces",
  ids: "ids",
  bcf: "bcf",
} as const;

export type OpfsNamespace =
  (typeof OPFS_NAMESPACES)[keyof typeof OPFS_NAMESPACES];

export type OpfsEntry = {
  name: string;
  size: number;
  lastModified: number;
};

export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export class OpfsUnavailableError extends Error {
  constructor() {
    super(
      "This browser has no Origin Private File System, so sessions cannot be cached locally.",
    );
    this.name = "OpfsUnavailableError";
  }
}

async function namespaceDir(
  namespace: OpfsNamespace,
  { create = true }: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(namespace, { create });
}

/**
 * OPFS keys are file names, so anything that could escape the directory or
 * collide across namespaces has to go. Percent-encoding keeps the mapping
 * reversible, which matters when a key is a model file name shown back to the user.
 */
function encodeKey(key: string): string {
  return encodeURIComponent(key).replace(/\*/g, "%2A");
}

function decodeKey(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export async function writeBytes(
  namespace: OpfsNamespace,
  key: string,
  data: ArrayBuffer | Uint8Array | Blob,
): Promise<void> {
  const dir = await namespaceDir(namespace);
  const handle = await dir.getFileHandle(encodeKey(key), { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data as FileSystemWriteChunkType);
  } finally {
    // `close()` is what commits the file; a throw before it leaves the previous
    // contents in place rather than a truncated file.
    await writable.close();
  }
}

export async function readBytes(
  namespace: OpfsNamespace,
  key: string,
): Promise<ArrayBuffer | null> {
  try {
    const dir = await namespaceDir(namespace, { create: false });
    const handle = await dir.getFileHandle(encodeKey(key));
    return await (await handle.getFile()).arrayBuffer();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function readFileHandle(
  namespace: OpfsNamespace,
  key: string,
): Promise<File | null> {
  try {
    const dir = await namespaceDir(namespace, { create: false });
    const handle = await dir.getFileHandle(encodeKey(key));
    return await handle.getFile();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export async function writeJson<T>(
  namespace: OpfsNamespace,
  key: string,
  value: T,
): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  await writeBytes(namespace, key, encoded);
}

export async function readJson<T>(
  namespace: OpfsNamespace,
  key: string,
): Promise<T | null> {
  const bytes = await readBytes(namespace, key);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    // A half-written or hand-edited draft should not brick the page it belongs
    // to; treat it as absent and let the caller start fresh.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listing and removal
// ---------------------------------------------------------------------------

export async function list(namespace: OpfsNamespace): Promise<OpfsEntry[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await namespaceDir(namespace, { create: false });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: OpfsEntry[] = [];
  // `entries()` is an async iterator on the handle; TS's DOM lib does not
  // declare it yet, hence the cast.
  const iterable = dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >;
  for await (const [name, handle] of iterable) {
    if (handle.kind !== "file") continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    entries.push({
      name: decodeKey(name),
      size: file.size,
      lastModified: file.lastModified,
    });
  }
  entries.sort((a, b) => b.lastModified - a.lastModified);
  return entries;
}

export async function remove(
  namespace: OpfsNamespace,
  key: string,
): Promise<void> {
  try {
    const dir = await namespaceDir(namespace, { create: false });
    await dir.removeEntry(encodeKey(key));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Drops one namespace. Used by "clear cached models" and friends. */
export async function clearNamespace(namespace: OpfsNamespace): Promise<void> {
  if (!isOpfsAvailable()) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(namespace, { recursive: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Drops everything this app has stored locally. */
export async function clearAll(): Promise<void> {
  await Promise.all(
    Object.values(OPFS_NAMESPACES).map((ns) => clearNamespace(ns)),
  );
}

/**
 * Bytes used and available, when the browser will say. Worth surfacing before
 * caching a 200 MB model — OPFS quota is a fraction of free disk and evicting
 * a workspace mid-session is a bad experience.
 */
export async function usage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null;
  }
  const { usage: used, quota } = await navigator.storage.estimate();
  if (used === undefined || quota === undefined) return null;
  return { usedBytes: used, quotaBytes: quota };
}

/**
 * Ask the browser to make this origin's storage persistent, so the OPFS cache
 * is not evicted under disk pressure. Chrome grants it silently for engaged
 * sites; Firefox prompts. Returns whether storage is persistent afterwards.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return false;
  }
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
