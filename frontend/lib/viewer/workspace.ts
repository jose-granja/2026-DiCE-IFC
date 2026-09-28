"use client";

/**
 * Saving and restoring a viewer session.
 *
 * A federation is a piece of work: which models, where they sit, what the
 * camera was looking at. Losing it to a reload is the difference between a tool
 * and a demo.
 *
 * **What is stored, and what is not.** The workspace holds `FileSystemFileHandle`s
 * — references the browser can re-open — never file contents. That keeps the
 * privacy line intact (nothing is copied anywhere) and keeps a 40-model
 * federation's workspace a few kilobytes. The trade-off is that restore needs
 * the File System Access API and the user's permission; a session whose files
 * came from a plain `<input type=file>` cannot be restored, and this module says
 * so rather than silently restoring a partial federation.
 *
 * Handles survive a reload because IndexedDB — which OPFS metadata is stored
 * alongside — can structured-clone them. Plain JSON cannot, so handles go to
 * IndexedDB and the rest goes to OPFS as JSON.
 */

import { OPFS_NAMESPACES, readJson, remove, writeJson } from "@/lib/storage/opfs";
import type { Vec3 } from "@/lib/ifc/types";
import type { CameraProjection } from "./camera";

const WORKSPACE_KEY = "current";
const HANDLE_DB = "dice-ifc-workspace";
const HANDLE_STORE = "file-handles";

export type WorkspaceModelEntry = {
  /** Matches the key in the handle store. */
  handleKey: string;
  name: string;
  colour: string;
  visible: boolean;
  manualOffset?: Vec3;
};

export type WorkspaceCamera = {
  position: Vec3;
  target: Vec3;
  projection?: CameraProjection;
  fov?: number;
  viewHeight?: number;
};

export type Workspace = {
  version: 1;
  savedAt: string;
  models: WorkspaceModelEntry[];
  camera?: WorkspaceCamera;
};

export type RestorableModel = {
  entry: WorkspaceModelEntry;
  file: File;
  /** Carried through so a restored session can be saved again. */
  handle: FileSystemFileHandle;
};

export type RestoreResult = {
  models: RestorableModel[];
  camera?: WorkspaceCamera;
  /** Entries that could not be restored, with why — surfaced, never swallowed. */
  skipped: Array<{ name: string; reason: string }>;
};

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
      const request = fn(
        db.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SaveModelInput = {
  name: string;
  colour: string;
  visible: boolean;
  manualOffset?: Vec3;
  /** Absent for files chosen through a plain file input. */
  handle?: FileSystemFileHandle;
};

/**
 * Persist the current session. Models without a file handle are recorded as
 * skipped rather than half-saved: a workspace that silently restores four of
 * six models is worse than one that says which two it cannot.
 */
export async function saveWorkspace(
  models: SaveModelInput[],
  camera?: WorkspaceCamera,
): Promise<{ saved: number; unsaveable: string[] }> {
  const entries: WorkspaceModelEntry[] = [];
  const unsaveable: string[] = [];

  for (const [index, model] of models.entries()) {
    if (!model.handle) {
      unsaveable.push(model.name);
      continue;
    }
    const handleKey = `${index}:${model.name}`;
    await withHandleStore("readwrite", (store) =>
      store.put(model.handle!, handleKey),
    );
    entries.push({
      handleKey,
      name: model.name,
      colour: model.colour,
      visible: model.visible,
      manualOffset: model.manualOffset,
    });
  }

  const workspace: Workspace = {
    version: 1,
    savedAt: new Date().toISOString(),
    models: entries,
    camera,
  };
  await writeJson(OPFS_NAMESPACES.workspaces, WORKSPACE_KEY, workspace);

  return { saved: entries.length, unsaveable };
}

export async function hasWorkspace(): Promise<boolean> {
  const workspace = await readJson<Workspace>(
    OPFS_NAMESPACES.workspaces,
    WORKSPACE_KEY,
  );
  return (workspace?.models.length ?? 0) > 0;
}

export async function clearWorkspace(): Promise<void> {
  await remove(OPFS_NAMESPACES.workspaces, WORKSPACE_KEY);
  await withHandleStore("readwrite", (store) => store.clear());
}

export async function peekWorkspace(): Promise<Workspace | null> {
  return readJson<Workspace>(OPFS_NAMESPACES.workspaces, WORKSPACE_KEY);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Re-open the saved files.
 *
 * **Must be called from a user gesture.** `requestPermission` on a stored handle
 * needs transient activation; called from an effect it resolves to `prompt`
 * without ever showing a prompt, and every model silently fails to restore.
 * That is why the UI restores from a button, not on page load.
 */
export async function restoreWorkspace(): Promise<RestoreResult | null> {
  const workspace = await peekWorkspace();
  if (!workspace) return null;

  const models: RestorableModel[] = [];
  const skipped: RestoreResult["skipped"] = [];

  for (const entry of workspace.models) {
    try {
      const handle = await withHandleStore<FileSystemFileHandle | undefined>(
        "readonly",
        (store) => store.get(entry.handleKey),
      );
      if (!handle) {
        skipped.push({ name: entry.name, reason: "The saved file reference is gone." });
        continue;
      }

      const permission = await grantRead(handle);
      if (permission !== "granted") {
        skipped.push({
          name: entry.name,
          reason: "Permission to read the file was not granted.",
        });
        continue;
      }

      models.push({ entry, file: await handle.getFile(), handle });
    } catch (error) {
      // A moved, renamed or deleted file throws here. Report it per model; one
      // missing file must not lose the rest of the federation.
      skipped.push({
        name: entry.name,
        reason:
          error instanceof Error ? error.message : "The file could not be opened.",
      });
    }
  }

  return { models, camera: workspace.camera, skipped };
}

async function grantRead(handle: FileSystemFileHandle): Promise<PermissionState> {
  const descriptor = { mode: "read" as const };

  const current = await handle.queryPermission?.(descriptor);
  if (current === "granted") return "granted";

  return (await handle.requestPermission?.(descriptor)) ?? "denied";
}
