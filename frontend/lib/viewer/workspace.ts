"use client";

/**
 * Save and Restore: the viewer session kept in this browser.
 *
 * The same project as "Project → Save project folder" (`lib/project/`) — models,
 * point clouds, the context model, IDS, BCF, the quantity list and clash matrix
 * as workbooks, and a `project.json` with the camera, filters, planes,
 * measurements and the rest — but written to the browser's own storage instead
 * of a folder the user picks, so saving is one click and restoring needs no
 * folder at all. Restore hands the result to the very restore the project
 * folder uses, so the two can never disagree about what a session is.
 *
 * **Where the bytes go.** The project folder lives in the Origin Private File
 * System, which no other site and no server can read (AGENTS.md §1: the
 * boundary is the machine). A file the browser can reopen by itself — opened
 * through "Add models" where the File System Access API exists — is not copied:
 * its handle goes to IndexedDB, which can structured-clone handles, and the
 * file is read from where it is on restore. Anything else (a dropped file, a
 * generated workbook) is copied in. Clearing site data removes all of it.
 *
 * **Restore must be called from a user gesture.** `requestPermission` on a
 * stored handle needs transient activation; called from an effect it resolves
 * to `prompt` without ever prompting. That is why Restore is a button.
 */

import { readProjectFromEntries, writeProjectFolder, type ProjectSource } from "@/lib/project/folder";
import type { BuiltProject } from "@/lib/project/build";
import { PROJECT_FILE, PROJECT_FORMAT, PROJECT_VERSION } from "@/lib/project/manifest";
import type { Vec3 } from "@/lib/ifc/types";
import { OPFS_NAMESPACES, isOpfsAvailable, readJson, remove } from "@/lib/storage/opfs";
import type { CameraProjection } from "./camera";

/** Inside the `workspaces` namespace. */
const PROJECT_DIR = "project";
/** The first workspace format: a JSON of handle keys and a camera. Read, never written. */
const LEGACY_KEY = "current";

const HANDLE_DB = "dice-ifc-workspace";
const HANDLE_STORE = "file-handles";
/** Handles stored for the project, keyed by their path in the project folder. */
const HANDLE_PREFIX = "project:";

// ---------------------------------------------------------------------------
// Handle storage (IndexedDB — OPFS holds bytes, not live handles)
// ---------------------------------------------------------------------------

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withHandleStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openHandleDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function storedHandles(): Promise<Map<string, FileSystemFileHandle>> {
  const [keys, values] = await Promise.all([
    withHandleStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys()),
    withHandleStore<FileSystemFileHandle[]>("readonly", (store) => store.getAll()),
  ]);
  return new Map(keys.map((key, index) => [String(key), values[index]]));
}

async function grantRead(handle: FileSystemFileHandle): Promise<PermissionState> {
  const descriptor = { mode: "read" as const };
  const current = await handle.queryPermission?.(descriptor);
  if (current === "granted") return "granted";
  return (await handle.requestPermission?.(descriptor)) ?? "denied";
}

/** The file behind a handle, or null when it moved, went, or was not allowed. */
async function openHandle(handle: FileSystemFileHandle): Promise<File | null> {
  try {
    if ((await grantRead(handle)) !== "granted") return null;
    return await handle.getFile();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The project folder in OPFS
// ---------------------------------------------------------------------------

async function workspacesDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsAvailable()) return null;
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(OPFS_NAMESPACES.workspaces, { create });
  } catch {
    return null;
  }
}

/** Every file under a directory, with its path relative to it. */
async function listFiles(
  directory: FileSystemDirectoryHandle,
  prefix = "",
): Promise<Array<{ path: string; file: File }>> {
  const out: Array<{ path: string; file: File }> = [];
  // `entries()` is not in every TypeScript DOM lib yet; it is in every browser with OPFS.
  const entries = (directory as unknown as {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind === "directory") {
      out.push(...(await listFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
    } else {
      out.push({ path: `${prefix}${name}`, file: await (handle as FileSystemFileHandle).getFile() });
    }
  }
  return out;
}

async function projectDir(): Promise<FileSystemDirectoryHandle | null> {
  const workspaces = await workspacesDir(false);
  if (!workspaces) return null;
  try {
    return await workspaces.getDirectoryHandle(PROJECT_DIR);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export class WorkspaceUnavailableError extends Error {
  constructor() {
    super("This browser has no private file storage to keep the workspace in.");
    this.name = "WorkspaceUnavailableError";
  }
}

/**
 * Replace the saved workspace with this project.
 *
 * Written whole each time, never merged: a Restore must give back exactly what
 * was saved, not a mixture with an earlier session.
 */
export async function saveWorkspace(project: BuiltProject): Promise<void> {
  const workspaces = await workspacesDir(true);
  if (!workspaces) throw new WorkspaceUnavailableError();

  const referenced = new Set(project.handles.map((entry) => entry.path));
  await workspaces.removeEntry(PROJECT_DIR, { recursive: true }).catch(() => undefined);
  await writeProjectFolder(
    workspaces,
    PROJECT_DIR,
    project.files.filter((file) => !referenced.has(file.path)),
  );

  await withHandleStore("readwrite", (store) => store.clear());
  for (const { path, handle } of project.handles) {
    await withHandleStore("readwrite", (store) => store.put(handle, `${HANDLE_PREFIX}${path}`));
  }
  // The first format, superseded by this save.
  await remove(OPFS_NAMESPACES.workspaces, LEGACY_KEY).catch(() => undefined);
}

export async function hasWorkspace(): Promise<boolean> {
  const directory = await projectDir();
  if (directory) {
    try {
      await directory.getFileHandle(PROJECT_FILE);
      return true;
    } catch {
      // Fall through to the first format.
    }
  }
  const legacy = await readJson<LegacyWorkspace>(OPFS_NAMESPACES.workspaces, LEGACY_KEY).catch(() => null);
  return (legacy?.models.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * The saved workspace as a project source, ready for `restoreProject`, or null
 * when nothing is saved. Files whose handle cannot be reopened — moved,
 * deleted, permission refused — are simply absent, and the restore reports them
 * as missing rather than failing the rest.
 */
export async function readWorkspace(name: string): Promise<ProjectSource | null> {
  const directory = await projectDir();
  const handles = await storedHandles().catch(() => new Map<string, FileSystemFileHandle>());

  if (directory) {
    const entries = await listFiles(directory);
    if (entries.some((entry) => entry.path === PROJECT_FILE)) {
      for (const [key, handle] of handles) {
        if (!key.startsWith(HANDLE_PREFIX)) continue;
        const file = await openHandle(handle);
        if (file) entries.push({ path: key.slice(HANDLE_PREFIX.length), file });
      }
      return readProjectFromEntries(entries, name);
    }
  }

  return readLegacyWorkspace(name, handles);
}

// ---------------------------------------------------------------------------
// The first format, read so that nothing saved with it is lost
// ---------------------------------------------------------------------------

type LegacyWorkspace = {
  version: 1;
  savedAt: string;
  models: Array<{ handleKey: string; name: string; colour: string; visible: boolean; manualOffset?: Vec3 }>;
  camera?: { position: Vec3; target: Vec3; projection?: CameraProjection; fov?: number; viewHeight?: number };
};

/** Models and a camera were all it held; as a project, that is a manifest of models and a viewer. */
async function readLegacyWorkspace(
  name: string,
  handles: Map<string, FileSystemFileHandle>,
): Promise<ProjectSource | null> {
  const legacy = await readJson<LegacyWorkspace>(OPFS_NAMESPACES.workspaces, LEGACY_KEY).catch(() => null);
  if (!legacy || legacy.models.length === 0) return null;

  const entries: Array<{ path: string; file: File }> = [];
  const models = legacy.models.map((model, index) => ({
    path: `models/${index}-${model.name}`,
    name: model.name,
    colour: model.colour,
    visible: model.visible,
    manualOffset: model.manualOffset,
  }));
  for (const [index, model] of legacy.models.entries()) {
    const handle = handles.get(model.handleKey);
    const file = handle ? await openHandle(handle) : null;
    if (file) entries.push({ path: models[index].path, file });
  }
  const manifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: legacy.savedAt,
    models,
    viewer: { camera: legacy.camera ?? null },
  };
  entries.push({ path: PROJECT_FILE, file: new File([JSON.stringify(manifest)], PROJECT_FILE) });
  return readProjectFromEntries(entries, name);
}
