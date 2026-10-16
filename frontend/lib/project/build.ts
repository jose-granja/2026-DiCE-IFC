/**
 * Turning a viewer session into a project folder, and a project folder back
 * into what to load — the parts of saving and restoring that need no store, no
 * renderer and no worker, so they can be tested on their own.
 *
 * `session.ts` reads the live state into a `SessionSnapshot` and applies a
 * `RestorePlan`; this module only translates between them and the files.
 */

import type { ClashMatrix } from "@/lib/clash/types";
import { createClashWorkbook } from "@/lib/clash/workbook";
import { createQuantityWorkbook } from "@/lib/spreadsheets/quantity-workbook";
import type { Vec3 } from "@/lib/ifc/types";
import type { DisplaySettingsValues } from "@/lib/viewer/display-settings";
import type { SectionCapStyle } from "@/lib/viewer/section-cap";
import type {
  AngleMeasurement,
  AreaMeasurement,
  Measurement,
  SectionPlane,
  SnapTargets,
  VolumeMeasurement,
} from "@/lib/viewer/tools";
import type { TypeVisibilityState } from "@/lib/viewer/type-visibility";
import type { GlobeLayerId } from "@/lib/viewer/globe-layers";
import { serializeLenses } from "@/lib/lens/file";
import type { Lens } from "@/lib/lens/types";
import type { StoredQueryListItem } from "@/lib/viewer/quantity-list-storage";
import type { ViewerCameraState } from "@/lib/viewer/renderer";
import type { PointColourMode } from "@/lib/pointcloud/colour";
import type { CloudFrame } from "@/lib/pointcloud/place";

import {
  PROJECT_FILE,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  type ProjectElementRef,
  type ProjectManifest,
} from "./manifest";
import { uniquePaths, type ProjectFile, type ProjectSource } from "./folder";

/** An element in the live session, by the model id it has now. */
export type LiveRef = { modelId: string; expressId: number };

export type SessionSnapshot = {
  models: Array<{
    id: string;
    name: string;
    /** Absent when the source file is no longer available. */
    file: File | undefined;
    /** How the browser can reopen the file later, when it was opened with a picker that gives one. */
    handle?: FileSystemFileHandle;
    colour: string;
    visible: boolean;
    manualOffset?: Vec3;
  }>;
  pointClouds: Array<{
    name: string;
    file: File | undefined;
    handle?: FileSystemFileHandle;
    frame: CloudFrame;
    mode: PointColourMode;
    size: number;
    visible: boolean;
  }>;
  context: {
    file: File;
    visible: boolean;
    clipEnabled: boolean;
    clipRadius: string;
  } | null;
  /** The IDS the validator is set to, as XML. */
  validationIds: { xml: string; title: string; source: "file" | "editor" } | null;
  /** The IDS editor's document, serialised — null when it has no specifications. */
  editorIds: string | null;
  /** The BCF topics, serialised — null when there are none. */
  bcf: Uint8Array | null;
  /** The BCF panel's "Show 3D markers". */
  bcfMarkersVisible: boolean;
  quantities: StoredQueryListItem[];
  clash: ClashMatrix | null;

  panel: string;
  camera: ViewerCameraState | null;
  display: DisplaySettingsValues;
  typeVisibility: TypeVisibilityState;
  sectionCapStyle: SectionCapStyle;
  snapTargets: SnapTargets;
  areaMode: "points" | "face";
  volumeMode: "element" | "box";
  pointCloudEdgeShading: boolean;
  globe: { on: boolean; layer: GlobeLayerId; assetId: string; url: string };
  worldOrigin: { source: string; mapPosition?: Vec3 } | null;

  typeFilter: string[];
  facets: Record<string, string[]>;
  hidden: LiveRef[];
  isolated: LiveRef[] | null;
  isolationFilterMode: "replace" | "intersect" | null;
  selection: LiveRef[];

  lenses: { saved: Lens[]; activeId: string | null };
  sectionPlanes: SectionPlane[];
  measurements: Measurement[];
  angleMeasurements: AngleMeasurement[];
  areaMeasurements: AreaMeasurement[];
  volumeMeasurements: VolumeMeasurement[];
};

export type BuiltProject = {
  manifest: ProjectManifest;
  /** `project.json` first, then every data file. */
  files: ProjectFile[];
  /** Things that could not go into the folder, by name — said, never dropped quietly. */
  skipped: Array<{ name: string; reason: "noSource" }>;
  /**
   * The files the browser can reopen by itself, by their path in the folder —
   * what lets a project kept in the browser store a reference instead of a copy.
   */
  handles: Array<{ path: string; handle: FileSystemFileHandle }>;
};

/** Parse a ref key (`modelId#expressId`) back into its parts. */
export function parseLiveRefKey(key: string): LiveRef | null {
  const split = key.lastIndexOf("#");
  if (split <= 0) return null;
  const expressId = Number(key.slice(split + 1));
  if (!Number.isInteger(expressId)) return null;
  return { modelId: key.slice(0, split), expressId };
}

export function buildProject(session: SessionSnapshot, savedAt = new Date()): BuiltProject {
  const files: ProjectFile[] = [];
  const skipped: BuiltProject["skipped"] = [];
  const handles: BuiltProject["handles"] = [];
  const pathFor = uniquePaths();

  // Models first: their order decides the federation's world origin, and with
  // it where every plane and measurement sits, so it is kept exactly.
  const modelIndex = new Map<string, number>();
  const models: ProjectManifest["models"] = [];
  for (const model of session.models) {
    if (!model.file) {
      skipped.push({ name: model.name, reason: "noSource" });
      continue;
    }
    const path = pathFor("models", model.name);
    modelIndex.set(model.id, models.length);
    models.push({
      path,
      name: model.name,
      colour: model.colour,
      visible: model.visible,
      manualOffset: model.manualOffset,
    });
    files.push({ path, data: model.file });
    if (model.handle) handles.push({ path, handle: model.handle });
  }

  /** A live element as a saved one, or null if its model is not in the folder. */
  const ref = (live: LiveRef): ProjectElementRef | null => {
    const model = modelIndex.get(live.modelId);
    return model === undefined ? null : { model, expressId: live.expressId };
  };
  const refs = (live: LiveRef[]) =>
    live.map(ref).filter((entry): entry is ProjectElementRef => entry !== null);

  const pointClouds: ProjectManifest["pointClouds"] = [];
  for (const cloud of session.pointClouds) {
    if (!cloud.file) {
      skipped.push({ name: cloud.name, reason: "noSource" });
      continue;
    }
    const path = pathFor("pointclouds", cloud.name);
    pointClouds.push({
      path,
      name: cloud.name,
      frame: cloud.frame,
      mode: cloud.mode,
      size: cloud.size,
      visible: cloud.visible,
    });
    files.push({ path, data: cloud.file });
    if (cloud.handle) handles.push({ path, handle: cloud.handle });
  }

  let context: ProjectManifest["context"] = null;
  if (session.context) {
    const path = pathFor("context", session.context.file.name);
    context = {
      path,
      name: session.context.file.name,
      visible: session.context.visible,
      clipEnabled: session.context.clipEnabled,
      clipRadius: session.context.clipRadius,
    };
    files.push({ path, data: session.context.file });
  }

  const ids: ProjectManifest["ids"] = { validation: null, editor: null };
  if (session.validationIds) {
    const title = session.validationIds.title || "specification";
    const path = pathFor("ids", `${title}.ids`);
    ids.validation = { path, title, source: session.validationIds.source };
    files.push({ path, data: new Blob([session.validationIds.xml], { type: "application/xml" }) });
  }
  if (session.editorIds) {
    const path = pathFor("ids", "editor.ids");
    ids.editor = { path };
    files.push({ path, data: new Blob([session.editorIds], { type: "application/xml" }) });
  }

  // The quantity list and the clash matrix go in as the workbooks the panels
  // already import and export, so they open in Excel and load back the same.
  // An empty one is left out: a workbook with no rows is not one the panels
  // can import, and "none" is what the manifest's null already says.
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  let quantities: ProjectManifest["quantities"] = null;
  if (session.quantities.length > 0) {
    const path = pathFor("quantities", "quantities.xlsx");
    quantities = { path };
    const workbook = createQuantityWorkbook(
      session.quantities.map((item, index) => ({
        code: item.code ?? "",
        description: item.description ?? item.name ?? `Quantity ${index + 1}`,
        query: item.query,
        result: null,
      })),
    );
    files.push({ path, data: new Blob([workbook as BlobPart], { type: xlsx }) });
  }
  let clash: ProjectManifest["clash"] = null;
  if (session.clash && session.clash.groups.length > 0) {
    const path = pathFor("clash", "clash-matrix.xlsx");
    clash = { path };
    files.push({ path, data: new Blob([createClashWorkbook(session.clash) as BlobPart], { type: xlsx }) });
  }

  // Lenses go in as the lens list the Lens tab downloads, so a project's lenses
  // can be uploaded on their own elsewhere. Built-ins are in every copy of the
  // app; with none of the user's own there is no file, only which one was on.
  const ownLenses = session.lenses.saved.filter((lens) => !lens.builtin);
  const lenses: ProjectManifest["lenses"] = { path: null, activeId: session.lenses.activeId };
  if (ownLenses.length > 0) {
    const path = pathFor("lenses", "lenses.json");
    lenses.path = path;
    files.push({
      path,
      data: new Blob([serializeLenses(ownLenses, session.lenses.activeId)], { type: "application/json" }),
    });
  }

  let bcf: ProjectManifest["bcf"] = null;
  if (session.bcf) {
    const path = pathFor("bcf", "topics.bcf");
    bcf = { path, markersVisible: session.bcfMarkersVisible };
    files.push({ path, data: new Blob([session.bcf as BlobPart], { type: "application/zip" }) });
  }

  const areas: ProjectManifest["measurements"]["areas"] = [];
  for (const area of session.areaMeasurements) {
    if (area.kind === "points") {
      areas.push({ id: area.id, kind: "points", points: area.points });
      continue;
    }
    const element = ref({ modelId: area.modelId, expressId: area.expressId });
    if (element) areas.push({ id: area.id, kind: "face", element, triangles: area.triangles });
  }
  const volumes: ProjectManifest["measurements"]["volumes"] = [];
  for (const volume of session.volumeMeasurements) {
    if (volume.kind === "box") {
      volumes.push({ id: volume.id, kind: "box", corner1: volume.corner1, corner2: volume.corner2 });
      continue;
    }
    const element = ref({ modelId: volume.modelId, expressId: volume.expressId });
    if (element) {
      volumes.push({
        id: volume.id,
        kind: "element",
        element,
        volume: volume.volume,
        centroid: volume.centroid,
      });
    }
  }

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: savedAt.toISOString(),
    models,
    pointClouds,
    context,
    ids,
    bcf,
    quantities,
    clash,
    viewer: {
      panel: session.panel,
      camera: session.camera,
      display: session.display,
      typeVisibility: session.typeVisibility,
      sectionCapStyle: session.sectionCapStyle,
      snapTargets: session.snapTargets,
      areaMode: session.areaMode,
      volumeMode: session.volumeMode,
      pointCloudEdgeShading: session.pointCloudEdgeShading,
      globe: session.globe,
      worldOrigin: session.worldOrigin,
    },
    filters: {
      classes: session.typeFilter,
      facets: session.facets,
      hidden: refs(session.hidden),
      isolated: session.isolated ? refs(session.isolated) : null,
      isolationFilterMode: session.isolationFilterMode,
      selection: refs(session.selection),
    },
    lenses,
    sectionPlanes: session.sectionPlanes,
    measurements: {
      distances: session.measurements,
      angles: session.angleMeasurements,
      areas,
      volumes,
    },
  };

  const json = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  return { manifest, files: [{ path: PROJECT_FILE, data: json }, ...files], skipped, handles };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type RestorePlan = {
  manifest: ProjectManifest;
  models: Array<{ index: number; entry: ProjectManifest["models"][number]; file: File }>;
  pointClouds: Array<{ entry: ProjectManifest["pointClouds"][number]; file: File }>;
  context: { entry: NonNullable<ProjectManifest["context"]>; file: File } | null;
  validationIds: { title: string; source: "file" | "editor"; file: File } | null;
  editorIds: File | null;
  bcf: File | null;
  /** The quantity list's workbook; read by `session.ts`, which has a DOM to parse it with. */
  quantities: File | null;
  clash: File | null;
  /** The lens list; read by `session.ts` before anything is closed. */
  lenses: File | null;
  /** Files the manifest names that the folder does not have. */
  missing: string[];
};

/** Match the manifest's paths to the folder's files. Nothing is read yet. */
export function planRestore(manifest: ProjectManifest, source: ProjectSource): RestorePlan {
  const missing: string[] = [];
  const find = (path: string) => {
    const file = source.file(path);
    if (!file) missing.push(path);
    return file;
  };

  const models: RestorePlan["models"] = [];
  manifest.models.forEach((entry, index) => {
    const file = find(entry.path);
    // The original name, not the folder's (which may carry a " (2)").
    if (file) models.push({ index, entry, file: renamed(file, entry.name) });
  });

  const pointClouds: RestorePlan["pointClouds"] = [];
  for (const entry of manifest.pointClouds) {
    const file = find(entry.path);
    if (file) pointClouds.push({ entry, file: renamed(file, entry.name) });
  }

  const contextFile = manifest.context ? find(manifest.context.path) : undefined;
  const validationFile = manifest.ids.validation ? find(manifest.ids.validation.path) : undefined;
  const editorFile = manifest.ids.editor ? find(manifest.ids.editor.path) : undefined;
  const bcfFile = manifest.bcf ? find(manifest.bcf.path) : undefined;
  const quantitiesFile = manifest.quantities ? find(manifest.quantities.path) : undefined;
  const clashFile = manifest.clash ? find(manifest.clash.path) : undefined;
  const lensesFile = manifest.lenses.path ? find(manifest.lenses.path) : undefined;

  return {
    manifest,
    models,
    pointClouds,
    context:
      manifest.context && contextFile
        ? { entry: manifest.context, file: renamed(contextFile, manifest.context.name) }
        : null,
    validationIds:
      manifest.ids.validation && validationFile
        ? {
            title: manifest.ids.validation.title,
            source: manifest.ids.validation.source,
            file: validationFile,
          }
        : null,
    editorIds: editorFile ?? null,
    bcf: bcfFile ?? null,
    quantities: quantitiesFile ?? null,
    clash: clashFile ?? null,
    lenses: lensesFile ?? null,
    missing,
  };
}

function renamed(file: File, name: string): File {
  return file.name === name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/** Saved elements as live refs, given which model index became which model id. */
export function liveRefs(
  saved: ProjectElementRef[],
  modelIds: ReadonlyMap<number, string>,
): LiveRef[] {
  const out: LiveRef[] = [];
  for (const entry of saved) {
    const modelId = modelIds.get(entry.model);
    // A model that failed to load takes its elements with it.
    if (modelId) out.push({ modelId, expressId: entry.expressId });
  }
  return out;
}
