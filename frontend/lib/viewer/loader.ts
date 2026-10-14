"use client";

/**
 * Loading models into the viewer.
 *
 * Files come from a drop, a file input, or the File System Access API. In every
 * case the bytes go straight to a worker and never near a network call — see
 * AGENTS.md §1.
 *
 * Files are loaded concurrently: the worker pool caps how many parse at once,
 * so handing it ten files at once is what makes a federation load in parallel
 * rather than one at a time. One file failing must not take the others with it.
 */

import { openModel, type ModelHandle } from "@/lib/workers/ifc-client";
import { unwrapModel } from "./container";
import { verifySignedContainer } from "./signature";
import { IFC_FILE_EXTENSIONS } from "@/config";
import { isPointCloudFile, POINT_CLOUD_FORMATS } from "@/lib/pointcloud/formats";
import { loadPointCloudFile } from "./pointcloud-loader";
import { useViewerStore, type ViewerModel } from "./store";

/**
 * Live handles, keyed by model id. Kept outside the store because a Comlink
 * proxy is not serialisable and must never end up in persisted state.
 */
const handles = new Map<string, ModelHandle>();

/**
 * File handles for models opened through the File System Access API, keyed by
 * model id. These are what makes workspace restore possible — a plain
 * `<input type=file>` gives a `File` with no way back to it after a reload.
 */
const fileHandles = new Map<string, FileSystemFileHandle>();

/**
 * The file each model was opened from, exactly as opened — a `.ifczip` stays a
 * `.ifczip`, so a signed container saved into a project folder still verifies.
 * A `File` from a picker or a drop is a reference to the bytes on disk, not a
 * copy in memory, so holding one costs next to nothing.
 */
const sourceFiles = new Map<string, File>();

export function getSourceFile(modelId: string): File | undefined {
  return sourceFiles.get(modelId);
}

export function getModelHandle(modelId: string): ModelHandle | undefined {
  return handles.get(modelId);
}

export function getFileHandle(
  modelId: string,
): FileSystemFileHandle | undefined {
  return fileHandles.get(modelId);
}

export function hasIfcExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return IFC_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export type PickedFile = {
  file: File;
  /** Present only with the File System Access API. */
  handle?: FileSystemFileHandle;
};

export type LoadOutcome =
  | { file: string; ok: true; modelId: string }
  | { file: string; ok: false; error: string };

/**
 * Parse one file and register it in the viewer store.
 *
 * The model appears in the store immediately, in a `parsing` state, so the
 * model list shows progress rather than nothing. Geometry is fetched after the
 * metadata so the spatial tree and property inspector become usable first —
 * on a large model that is the difference between a usable UI in one second and
 * a blank one for ten.
 */
export async function loadModelFile(
  file: File,
  fileHandle?: FileSystemFileHandle,
): Promise<LoadOutcome> {
  const store = useViewerStore.getState();
  let modelId: string | null = null;

  try {
    // A `.ifczip` is a ZIP around the model; a signed one is the same archive
    // with META-INF/ added. Both unwrap to the same bytes the parser wants.
    const unwrapped = await unwrapModel(file);

    const handle = await openModel(unwrapped.file, {
      onProgress: (progress) => {
        if (!modelId) return;
        useViewerStore.getState().updateModel(modelId, {
          load: {
            status: "parsing",
            phase: progress.phase,
            percent: progress.percent,
          },
        });
      },
    });

    modelId = handle.summary.id;
    handles.set(modelId, handle);
    sourceFiles.set(modelId, file);
    if (fileHandle) fileHandles.set(modelId, fileHandle);

    // The model's own name, not the entry's: "model.ifczip" is what the user
    // opened and what they will look for in the list.
    handle.summary.name = file.name;

    const model: ViewerModel = {
      summary: handle.summary,
      colour: undefined as never, // assigned by the store
      visible: true,
      load: { status: "parsing", phase: "metadata", percent: 90 },
      georeference: { hasGeoreference: false },
      spatialTree: null,
      entityTypes: [],
      coordinates: null,
      hasGeometry: false,
      // `null` means "a container, still being checked". `undefined` means
      // "not a container at all" — a distinction the UI depends on to avoid
      // labelling a plain .ifc as unsigned.
      signature: unwrapped.container ? null : undefined,
    };
    store.addModel(model);

    // Deliberately not awaited: container verification and raw IFC embedded
    // signature discovery must not hold up the model. The latter reads, scans
    // and verifies in its own worker; an unsigned IFC keeps no badge.
    void verifySignedContainer(modelId, file.name, unwrapped);

    // Metadata first — cheap, and it is what the panels need.
    const [georeference, spatialTree, entityTypes] = await Promise.all([
      handle.getGeoreferencing(),
      handle.getSpatialTree(),
      handle.getEntityTypes(),
    ]);

    useViewerStore.getState().updateModel(modelId, {
      georeference,
      spatialTree,
      entityTypes,
      load: { status: "geometry", phase: "geometry", percent: 0 },
    });

    return { file: file.name, ok: true, modelId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (modelId) {
      useViewerStore
        .getState()
        .updateModel(modelId, { load: { status: "failed", error: message } });
    }
    return { file: file.name, ok: false, error: message };
  }
}

/**
 * Load several files at once.
 *
 * `Promise.allSettled` rather than `Promise.all`: dropping five models and
 * having one corrupt file discard the other four would be its own bug.
 */
export async function loadModelFiles(
  inputs: Array<File | PickedFile>,
): Promise<LoadOutcome[]> {
  const picked: PickedFile[] = inputs.map((input) =>
    input instanceof File ? { file: input } : input,
  );

  // Point clouds are not models and take a different road: they are decoded and
  // drawn, never parsed as IFC. A scan dropped in with a model should just work.
  const clouds = picked.filter((p) => isPointCloudFile(p.file.name));
  const accepted = picked.filter((p) => hasIfcExtension(p.file.name));
  const rejected: LoadOutcome[] = picked
    .filter((p) => !hasIfcExtension(p.file.name) && !isPointCloudFile(p.file.name))
    .map((p) => ({
      file: p.file.name,
      ok: false,
      error: `Not an IFC file or a point cloud. Expected one of ${[
        ...IFC_FILE_EXTENSIONS,
        ...POINT_CLOUD_FORMATS.map((format) => `.${format}`),
      ].join(", ")}.`,
    }));

  const cloudResults = Promise.all(clouds.map((p) => loadPointCloudFile(p.file, {}, p.handle)));

  const settled = await Promise.allSettled(
    accepted.map((p) => loadModelFile(p.file, p.handle)),
  );

  const results: LoadOutcome[] = settled.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          file: accepted[index].file.name,
          ok: false,
          error: String(outcome.reason),
        },
  );

  const loadedClouds: LoadOutcome[] = (await cloudResults).map((outcome) =>
    outcome.ok
      ? { file: outcome.file, ok: true, modelId: outcome.cloudId }
      : { file: outcome.file, ok: false, error: outcome.error },
  );

  return [...rejected, ...results, ...loadedClouds];
}

/** Close a model: unload it in the worker and drop it from the store. */
export async function unloadModel(modelId: string): Promise<void> {
  const handle = handles.get(modelId);
  handles.delete(modelId);
  sourceFiles.delete(modelId);
  fileHandles.delete(modelId);
  useViewerStore.getState().removeModel(modelId);
  // The store is updated first so the UI never renders a model whose worker
  // state has already gone.
  await handle?.close();
}

export async function unloadAllModels(): Promise<void> {
  const ids = [...handles.keys()];
  await Promise.allSettled(ids.map(unloadModel));
}

// ---------------------------------------------------------------------------
// File pickers
// ---------------------------------------------------------------------------

/**
 * True when the browser has the File System Access API.
 *
 * Worth branching on: it yields `FileSystemFileHandle`s, which can be persisted
 * to OPFS and re-opened after a reload without re-picking — which is what makes
 * workspace restore possible. A plain `<input type=file>` cannot do that.
 */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

/**
 * Open the native picker, returning handles when the browser provides them.
 * Returns an empty array when the user cancels — not an error.
 */
export async function pickIfcFiles(): Promise<PickedFile[]> {
  if (!supportsFileSystemAccess()) return [];

  try {
    const picked = await window.showOpenFilePicker!({
      multiple: true,
      types: [
        {
          description: "IFC models and point clouds",
          accept: {
            "application/x-step": [...IFC_FILE_EXTENSIONS],
            "application/octet-stream": POINT_CLOUD_FORMATS.map((format) => `.${format}`),
          },
        },
      ],
    });
    return Promise.all(
      picked.map(async (handle) => ({ file: await handle.getFile(), handle })),
    );
  } catch (error) {
    // AbortError is the user pressing Escape.
    if (error instanceof DOMException && error.name === "AbortError") return [];
    throw error;
  }
}

/**
 * Pull files out of a drop, walking directories so dropping a folder of models
 * federates them.
 */
export async function filesFromDataTransfer(
  transfer: DataTransfer,
): Promise<File[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null);

  // No directory support (or a browser that does not expose entries): fall back
  // to the flat file list.
  if (entries.every((entry) => entry === null)) {
    return [...transfer.files];
  }

  const files: File[] = [];
  await Promise.all(entries.map((entry) => collectEntry(entry, files)));
  return files;
}

async function collectEntry(
  entry: FileSystemEntry | null,
  into: File[],
): Promise<void> {
  if (!entry) return;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (file) into.push(file);
    return;
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most 100 at a time; keep reading until it is empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (batch.length === 0) break;
      await Promise.all(batch.map((child) => collectEntry(child, into)));
    }
  }
}
