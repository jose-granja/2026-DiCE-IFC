"use client";

/**
 * Reading the live viewer into a `SessionSnapshot`, and putting a loaded
 * project back — the half of saving and restoring that touches stores, the
 * renderer and the workers. The translation to and from files is `build.ts`.
 *
 * ## Restoring replaces the session
 *
 * Loading a project closes what is open and puts the project's state in its
 * place: models, point clouds, the context model, the viewer state, the
 * quantity list, the clash matrix, the BCF topics and the IDS being validated.
 * The IDS editor's document is replaced only when the project carries one — it
 * is authoring work on another page, and a project that never touched it
 * should not wipe it. The UI asks before any of this happens.
 */

import { emptyMatrix } from "@/lib/clash/matrix";
import { useClashStore } from "@/lib/clash/store";
import { serializeBcf } from "@/lib/bcf/serialize";
import { useBcfStore } from "@/lib/bcf/store";
import { parseIds } from "@/lib/ids/parse";
import { serializeIds } from "@/lib/ids/serialize";
import { useIdsStore } from "@/lib/ids/store";
import { useValidateStore } from "@/lib/ids/validate-store";
import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useGisAreaStore } from "@/lib/viewer/gis-area-store";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { useGlobeStore } from "@/lib/viewer/globe-store";
import { parseLensFile } from "@/lib/lens/file";
import { builtinLens } from "@/lib/lens/presets";
import { useLensStore } from "@/lib/lens/store";
import type { Lens } from "@/lib/lens/types";
import {
  applyDisplaySettings,
  displaySettingsValues,
  useDisplaySettingsStore,
} from "@/lib/viewer/display-settings";
import {
  facetSelectionFromJson,
  facetSelectionToJson,
  useFacetSelectionStore,
} from "@/lib/viewer/facet-selection-store";
import { getFileHandle, getSourceFile, loadModelFile, unloadAllModels } from "@/lib/viewer/loader";
import { useViewerPanelStore } from "@/lib/viewer/panel-store";
import {
  getPointCloudHandle,
  getPointCloudSource,
  loadPointCloudFile,
  removePointCloud,
} from "@/lib/viewer/pointcloud-loader";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import {
  readStoredQueryList,
  replaceStoredQueryList,
  type StoredQueryListItem,
} from "@/lib/viewer/quantity-list-storage";
import { readClashWorkbook } from "@/lib/clash/workbook";
import type { ClashMatrix } from "@/lib/clash/types";
import { readQuantityWorkbook } from "@/lib/spreadsheets/quantity-workbook";
import { refKey, useViewerStore } from "@/lib/viewer/store";
import type { AreaMeasurement, VolumeMeasurement } from "@/lib/viewer/tools";

import {
  buildProject,
  liveRefs,
  parseLiveRefKey,
  planRestore,
  type BuiltProject,
  type LiveRef,
  type SessionSnapshot,
} from "./build";
import type { ProjectSource } from "./folder";
import { parseProjectManifest, type ProjectManifest } from "./manifest";

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function refsOf(keys: Iterable<string>): LiveRef[] {
  return [...keys].map(parseLiveRefKey).filter((ref): ref is LiveRef => ref !== null);
}

export function snapshotSession(): SessionSnapshot {
  const viewer = useViewerStore.getState();
  const clouds = usePointCloudStore.getState().clouds;
  const context = useContextModelStore.getState();
  const validate = useValidateStore.getState();
  const editor = useIdsStore.getState().document;
  const bcf = useBcfStore.getState().file;

  return {
    models: viewer.models
      // A model that failed to open has nothing to restore into.
      .filter((model) => model.load.status !== "failed")
      .map((model) => ({
        id: model.summary.id,
        name: model.summary.name,
        file: getSourceFile(model.summary.id),
        handle: getFileHandle(model.summary.id),
        colour: model.colour,
        visible: model.visible,
        manualOffset: model.manualOffset,
      })),
    pointClouds: clouds
      .filter((cloud) => cloud.status !== "failed")
      .map((cloud) => ({
        name: cloud.name,
        file: getPointCloudSource(cloud.id),
        handle: getPointCloudHandle(cloud.id),
        frame: cloud.frame,
        mode: cloud.mode,
        size: cloud.size,
        visible: cloud.visible,
      })),
    context:
      context.file && context.loaded
        ? {
            file: context.file,
            visible: context.visible,
            clipEnabled: context.clipEnabled,
            clipRadius: context.clipRadius,
            appearance: context.appearance,
          }
        : null,
    validationIds: validate.idsXml
      ? { xml: validate.idsXml, title: validate.idsTitle, source: validate.source ?? "file" }
      : null,
    editorIds:
      editor.specifications.length > 0 ? serializeIds(editor, { generator: "DiCE-IFC" }) : null,
    bcf: bcf.topics.length > 0 ? serializeBcf(bcf).bytes : null,
    bcfMarkersVisible: useBcfStore.getState().markersVisible,
    quantities: readStoredQueryList(),
    clash: useClashStore.getState().matrix,

    panel: useViewerPanelStore.getState().current,
    camera: getActiveRenderer()?.getCameraState() ?? null,
    display: displaySettingsValues(useDisplaySettingsStore.getState()),
    typeVisibility: viewer.typeVisibility,
    sectionCapStyle: viewer.sectionCapStyle,
    snapTargets: viewer.snapTargets,
    areaMode: viewer.areaMode,
    volumeMode: viewer.volumeMode,
    pointCloudEdgeShading: usePointCloudStore.getState().edgeShading,
    globe: (() => {
      const globe = useGlobeStore.getState();
      return { on: globe.on, layer: globe.layer, assetId: globe.assetId, url: globe.url, imagery: globe.imagery };
    })(),
    worldOrigin: viewer.worldOrigin
      ? { source: viewer.worldOrigin.source, mapPosition: viewer.worldOrigin.mapPosition }
      : null,

    typeFilter: [...viewer.typeFilter].sort(),
    facets: facetSelectionToJson(useFacetSelectionStore.getState().selection),
    hidden: refsOf(viewer.hidden),
    isolated: viewer.isolated ? refsOf(viewer.isolated) : null,
    isolationFilterMode: viewer.isolationFilterMode,
    selection: viewer.selection.map((ref) => ({ modelId: ref.modelId, expressId: ref.expressId })),

    lenses: (() => {
      const lens = useLensStore.getState();
      return { saved: lens.lenses, activeId: lens.activeId };
    })(),
    sectionPlanes: viewer.sectionPlanes,
    measurements: viewer.measurements,
    angleMeasurements: viewer.angleMeasurements,
    areaMeasurements: viewer.areaMeasurements,
    volumeMeasurements: viewer.volumeMeasurements,
  };
}

export function buildCurrentProject(): BuiltProject {
  return buildProject(snapshotSession());
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestoreProgress =
  | { step: "reading" }
  | { step: "models"; done: number; total: number }
  | { step: "settings" }
  | { step: "context" }
  | { step: "globe" };

export type RestoreReport = {
  name: string;
  models: { loaded: number; failed: Array<{ name: string; error: string }> };
  pointClouds: { loaded: number; failed: Array<{ name: string; error: string }> };
  /** Paths the project names that the folder does not have. */
  missing: string[];
  /** Other things that did not come back as they were, in words for the user. */
  warnings: RestoreWarning[];
};

export type RestoreWarning =
  | { kind: "originMoved" }
  | { kind: "context"; error: string }
  | { kind: "contextNotPlaced" }
  | { kind: "ids"; error: string }
  | { kind: "bcf"; error: string }
  | { kind: "globe"; error: string }
  | { kind: "quantities"; error: string }
  | { kind: "clash"; error: string }
  | { kind: "lenses"; error: string }
  | { kind: "lensesSkipped"; count: number };

/** Fresh ids for restored items, so they can never equal one the store mints next. */
function restoredId(kind: string, index: number) {
  return `restored-${kind}-${Date.now().toString(36)}-${index}`;
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
}

/** Resolve once `check` holds for the store, or reject when `signal` aborts. */
function waitFor<T>(
  subscribe: (listener: () => void) => () => void,
  check: () => T | undefined,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const initial = check();
    if (initial !== undefined) {
      resolve(initial);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const onAbort = () => {
      stop();
      reject(new DOMException("The restore was cancelled.", "AbortError"));
    };
    const unsubscribe = subscribe(() => {
      const value = check();
      if (value !== undefined) {
        stop();
        resolve(value);
      }
    });
    signal?.addEventListener("abort", onAbort);
    if (timeoutMs) {
      timer = setTimeout(() => {
        stop();
        resolve(undefined);
      }, timeoutMs);
    }
  });
}

/** Close everything a project restore replaces. */
async function clearSession() {
  useGisAreaStore.getState().clear();
  await unloadAllModels();
  for (const cloud of usePointCloudStore.getState().clouds) removePointCloud(cloud.id);
  useContextModelStore.getState().clear();
  getActiveRenderer()?.setContextGeometry(null);
  useGlobeStore.getState().off();
  useFacetSelectionStore.getState().clear();
  useViewerStore.getState().reset();
  useValidateStore.getState().reset();
  useClashStore.getState().clearResult();
}

export type RestoreOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: RestoreProgress) => void;
  /**
   * Whether the user agreed to turn the 3D world context back on, when the
   * project had it on. Off unless said otherwise: it sends the building's
   * location to a third party, so it is never turned on without asking.
   */
  allowGlobe?: boolean;
};

/** Whether a project would turn the 3D world context on, so the UI can ask first. */
export function projectUsesGlobe(
  manifest: ProjectManifest,
): NonNullable<ProjectManifest["viewer"]["globe"]> | null {
  const globe = manifest.viewer.globe;
  return globe?.on ? globe : null;
}

export async function restoreProject(
  source: ProjectSource,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  const { signal, onProgress, allowGlobe = false } = options;
  onProgress?.({ step: "reading" });

  // Everything that can refuse the folder does so before anything is closed:
  // a bad project.json must not cost the user the session they have open.
  const manifest = parseProjectManifest(source.manifestText);
  const plan = planRestore(manifest, source);
  const validationXml = plan.validationIds ? await plan.validationIds.file.text() : null;
  const editorXml = plan.editorIds ? await plan.editorIds.text() : null;
  const bcfBytes = plan.bcf ? new Uint8Array(await plan.bcf.arrayBuffer()) : null;
  aborted(signal);

  const report: RestoreReport = {
    name: source.name,
    models: { loaded: 0, failed: [] },
    pointClouds: { loaded: 0, failed: [] },
    missing: plan.missing,
    warnings: [],
  };

  // The workbooks are read now, while nothing has been closed yet. One that
  // will not read — edited in Excel into something else — is reported and the
  // list or matrix already open is left alone, rather than replaced by nothing.
  // `undefined` means "leave it"; a project with none restores an empty one.
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let quantities: StoredQueryListItem[] | undefined = manifest.quantities ? undefined : [];
  if (plan.quantities) {
    try {
      quantities = readQuantityWorkbook(new Uint8Array(await plan.quantities.arrayBuffer())).map(
        (definition, index) => ({
          id: restoredId("quantity", index),
          level: definition.level,
          code: definition.code,
          description: definition.description,
          query: definition.query,
        }),
      );
    } catch (error) {
      report.warnings.push({ kind: "quantities", error: message(error) });
    }
  }
  let clash: ClashMatrix | undefined = manifest.clash ? undefined : emptyMatrix();
  if (plan.clash) {
    try {
      clash = readClashWorkbook(new Uint8Array(await plan.clash.arrayBuffer()));
    } catch (error) {
      report.warnings.push({ kind: "clash", error: message(error) });
    }
  }
  // Lenses the same way: a list that will not read leaves the user's own alone.
  // A project from before the list was a file carries them inline.
  let lenses: Lens[] = (manifest.lenses.saved as Lens[] | undefined) ?? [];
  if (plan.lenses) {
    try {
      const read = parseLensFile(await plan.lenses.text());
      lenses = read.lenses;
      if (read.skipped > 0) {
        report.warnings.push({ kind: "lensesSkipped", count: read.skipped });
      }
    } catch (error) {
      report.warnings.push({ kind: "lenses", error: message(error) });
    }
  }
  aborted(signal);

  await clearSession();

  // ---- models
  //
  // Opened in parallel, then put back in the saved order: the order picks the
  // federation's world origin, and render space — where section planes and
  // measurements are stored — is measured from it.
  const total = plan.models.length;
  let done = 0;
  onProgress?.({ step: "models", done, total });
  const modelIds = new Map<number, string>();
  await Promise.all(
    plan.models.map(async ({ index, entry, file }) => {
      const outcome = await loadModelFile(file);
      done += 1;
      onProgress?.({ step: "models", done, total });
      if (!outcome.ok || !outcome.modelId) {
        report.models.failed.push({ name: entry.name, error: outcome.ok ? "" : outcome.error });
        return;
      }
      modelIds.set(index, outcome.modelId);
      const viewer = useViewerStore.getState();
      if (entry.colour) viewer.updateModel(outcome.modelId, { colour: entry.colour });
      viewer.setModelVisible(outcome.modelId, entry.visible);
      if (entry.manualOffset) viewer.setManualOffset(outcome.modelId, entry.manualOffset);
    }),
  );
  aborted(signal);
  const ordered = [...modelIds.entries()].sort(([a], [b]) => a - b).map(([, id]) => id);
  useViewerStore.getState().reorderModels(ordered);

  const clouds = Promise.all(
    plan.pointClouds.map(async ({ entry, file }) => {
      const outcome = await loadPointCloudFile(file, {
        frame: entry.frame,
        mode: entry.mode,
        size: entry.size,
        visible: entry.visible,
      });
      if (outcome.ok) report.pointClouds.loaded += 1;
      else report.pointClouds.failed.push({ name: entry.name, error: outcome.error });
    }),
  );

  // Geometry arrives through the canvas; the camera has to wait for it, or the
  // canvas's own "fit to what just loaded" moves it straight back.
  await waitFor(
    useViewerStore.subscribe,
    () => {
      const models = useViewerStore.getState().models;
      const pending = ordered.some((id) => {
        const model = models.find((entry) => entry.summary.id === id);
        return model && model.load.status !== "ready" && model.load.status !== "failed";
      });
      return pending ? undefined : true;
    },
    signal,
  );
  await clouds;
  aborted(signal);

  for (const id of ordered) {
    const model = useViewerStore.getState().models.find((entry) => entry.summary.id === id);
    if (model?.load.status === "failed") {
      report.models.failed.push({ name: model.summary.name, error: model.load.error });
    } else if (model) {
      report.models.loaded += 1;
    }
  }

  // ---- viewer state
  onProgress?.({ step: "settings" });
  const viewer = manifest.viewer;
  const keys = (refs: typeof manifest.filters.hidden) =>
    new Set(liveRefs(refs, modelIds).map(refKey));

  useViewerStore.setState((state) => ({
    selection: liveRefs(manifest.filters.selection, modelIds),
    hidden: keys(manifest.filters.hidden),
    isolated: manifest.filters.isolated ? keys(manifest.filters.isolated) : null,
    isolationFilterMode: manifest.filters.isolated ? manifest.filters.isolationFilterMode : null,
    typeFilter: new Set(manifest.filters.classes),
    typeVisibility: viewer.typeVisibility ?? state.typeVisibility,
    sectionCapStyle: viewer.sectionCapStyle ?? state.sectionCapStyle,
    snapTargets: viewer.snapTargets ?? state.snapTargets,
    areaMode: viewer.areaMode ?? state.areaMode,
    volumeMode: viewer.volumeMode ?? state.volumeMode,
    sectionPlanes: manifest.sectionPlanes.map((plane, index) => ({
      ...plane,
      id: restoredId("section", index),
    })),
    measurements: manifest.measurements.distances.map((entry, index) => ({
      ...entry,
      id: restoredId("distance", index),
    })),
    angleMeasurements: manifest.measurements.angles.map((entry, index) => ({
      ...entry,
      id: restoredId("angle", index),
    })),
    areaMeasurements: manifest.measurements.areas.flatMap<AreaMeasurement>((entry, index) => {
      const id = restoredId("area", index);
      if (entry.kind === "points") return [{ id, kind: "points" as const, points: entry.points }];
      const modelId = modelIds.get(entry.element.model);
      return modelId
        ? [
            {
              id,
              kind: "face" as const,
              modelId,
              expressId: entry.element.expressId,
              triangles: entry.triangles,
            },
          ]
        : [];
    }),
    volumeMeasurements: manifest.measurements.volumes.flatMap<VolumeMeasurement>((entry, index) => {
      const id = restoredId("volume", index);
      if (entry.kind === "box") {
        return [{ id, kind: "box" as const, corner1: entry.corner1, corner2: entry.corner2 }];
      }
      const modelId = modelIds.get(entry.element.model);
      return modelId
        ? [
            {
              id,
              kind: "element" as const,
              modelId,
              expressId: entry.element.expressId,
              volume: entry.volume,
              centroid: entry.centroid,
            },
          ]
        : [];
    }),
  }));

  if (viewer.pointCloudEdgeShading !== undefined) {
    usePointCloudStore.getState().setEdgeShading(viewer.pointCloudEdgeShading);
  }
  if (viewer.display) {
    useDisplaySettingsStore.getState().set(viewer.display);
    applyDisplaySettings(getActiveRenderer(), viewer.display);
  }
  if (viewer.camera) getActiveRenderer()?.setCameraState(viewer.camera);

  // Planes and measurements are in render space. If the world origin did not
  // come back where it was — a model failed, or a file changed — they would
  // sit in the wrong place without anything looking wrong, so say so.
  const origin = useViewerStore.getState().worldOrigin;
  if (viewer.worldOrigin && origin) {
    const before = viewer.worldOrigin.mapPosition;
    const after = origin.mapPosition;
    const moved =
      origin.source !== viewer.worldOrigin.source ||
      Boolean(before) !== Boolean(after) ||
      (before && after && before.some((value, axis) => Math.abs(value - after[axis]) > 1e-3));
    if (moved) report.warnings.push({ kind: "originMoved" });
  }

  // ---- data the other panels hold
  {
    // The saved lens is turned on only if it is here: a list that did not read
    // leaves the user's own on rather than pointing at nothing.
    const store = useLensStore.getState();
    const wanted = manifest.lenses.activeId;
    const known =
      wanted === null ||
      builtinLens(wanted) !== undefined ||
      lenses.some((lens) => lens.id === wanted) ||
      store.lenses.some((lens) => lens.id === wanted);
    store.merge(lenses, known ? wanted : store.activeId);
  }
  if (quantities) replaceStoredQueryList(quantities);
  if (clash) useClashStore.getState().setMatrix(clash);

  if (validationXml !== null && plan.validationIds) {
    useValidateStore
      .getState()
      .setIds(validationXml, plan.validationIds.title, plan.validationIds.source);
  }
  if (editorXml !== null) {
    try {
      useIdsStore.getState().setDocument(parseIds(editorXml).document);
      // The editor page loads its saved draft when it opens; without this it
      // would put the old document straight back over the restored one.
      await useIdsStore.getState().saveDraft();
    } catch (error) {
      report.warnings.push({
        kind: "ids",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The BCF panel also reloads its draft on mount, so the draft is what has to
  // change — an empty one when the project has no topics, or the old topics
  // would come back the first time the BCF tab opened.
  const bcf = useBcfStore.getState();
  bcf.reset();
  if (bcfBytes) {
    try {
      bcf.importArchives([{ name: plan.manifest.bcf?.path ?? "topics.bcf", bytes: bcfBytes }]);
      // `reset` above turned the markers off; the project says whether they were on.
      if (manifest.bcf?.markersVisible) useBcfStore.getState().setMarkersVisible(true);
    } catch (error) {
      report.warnings.push({
        kind: "bcf",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    await useBcfStore.getState().saveDraft();
  } catch {
    // No OPFS (private browsing): the topics are still in memory for this visit.
  }
  aborted(signal);

  // ---- context model and 3D world context
  //
  // Both are placed through GIS using the shared georeferencing placement,
  // so the GIS tab is opened long enough for them to
  // be put down. Both stay when the tab closes again.
  const panels = useViewerPanelStore.getState();
  const globe = viewer.globe;
  if (globe) {
    useGlobeStore.getState().restore(
      { layer: globe.layer, assetId: globe.assetId, url: globe.url, imagery: globe.imagery ?? "roadmap" },
      globe.on && allowGlobe,
    );
  }
  const wantsGlobe = Boolean(globe?.on && allowGlobe);
  const wantsContext = Boolean(plan.context);

  if ((wantsGlobe || wantsContext) && report.models.loaded === 0) {
    if (wantsContext) report.warnings.push({ kind: "contextNotPlaced" });
    if (wantsGlobe) {
      useGlobeStore.getState().off();
      report.warnings.push({ kind: "globe", error: "" });
    }
  } else if (wantsGlobe || wantsContext) {
    if (wantsContext && plan.context) {
      onProgress?.({ step: "context" });
      useContextModelStore.getState().restore(plan.context.file, {
        visible: plan.context.entry.visible,
        clipEnabled: plan.context.entry.clipEnabled,
        clipRadius: plan.context.entry.clipRadius,
        appearance: plan.context.entry.appearance,
      });
    }
    panels.open("gis");

    const contextDone = wantsContext
      ? waitFor(
          useContextModelStore.subscribe,
          () => {
            const state = useContextModelStore.getState();
            return state.pending === null ? (state.pendingOutcome ?? undefined) : undefined;
          },
          signal,
          // A national city model can take minutes to clip; past this the
          // project is still usable, and the panel finishes on its own.
          5 * 60_000,
        )
      : Promise.resolve(undefined);
    const globeDone = wantsGlobe
      ? waitFor(
          useGlobeStore.subscribe,
          () => useGlobeStore.getState().pendingOutcome ?? undefined,
          signal,
          2 * 60_000,
        )
      : Promise.resolve(undefined);
    if (wantsGlobe) onProgress?.({ step: "globe" });

    const [contextOutcome, globeOutcome] = await Promise.all([contextDone, globeDone]);
    if (wantsContext) {
      if (!contextOutcome) report.warnings.push({ kind: "contextNotPlaced" });
      else if (!contextOutcome.ok) report.warnings.push({ kind: "context", error: contextOutcome.error });
    }
    if (wantsGlobe && (!globeOutcome || !globeOutcome.ok)) {
      report.warnings.push({ kind: "globe", error: globeOutcome && !globeOutcome.ok ? globeOutcome.error : "" });
    }
  }

  useFacetSelectionStore.getState().setSelection(facetSelectionFromJson(manifest.filters.facets));
  if (viewer.panel) panels.open(viewer.panel);

  return report;
}
