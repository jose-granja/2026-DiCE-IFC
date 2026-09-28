"use client";

/**
 * Main-thread handle on the IFC workers.
 *
 * Pages talk to this, never to `lib/ifc/adapter` directly — the adapter runs
 * inside the worker, and calling it on the UI thread would parse a 200 MB model
 * on the main thread.
 */

import * as Comlink from "comlink";

import { parseIdsForEngine } from "@/lib/ifc/ids-document";

import { WorkerPool } from "./pool";
import type { IfcWorkerApi } from "./ifc.worker";
import type {
  ElementInfo,
  FilterFacets,
  EntityQuery,
  EntitySummary,
  ModelGeometry,
  ModelVocabulary,
  VocabularyOptions,
  ExpressId,
  GeoreferencePatch,
  GeoreferenceView,
  LoadProgress,
  ModelSummary,
  PropertySetView,
  QuantityQuery,
  QuantityQueryResult,
  SpatialNodeView,
  StepExportOptions,
  StepExportResult,
  IdsModelReport,
  IdsValidationOptions,
} from "@/lib/ifc/types";

/**
 * A loaded model, pinned to the worker that parsed it. `ModelId`s are
 * worker-local, so the lease is held for the model's whole life and released by
 * `close()`.
 */
export type ModelHandle = {
  summary: ModelSummary;
  getEntities(query?: EntityQuery): Promise<EntitySummary[]>;
  getEntity(expressId: ExpressId): Promise<EntitySummary | null>;
  getEntityTypes(): Promise<Array<{ type: string; count: number }>>;
  getVocabulary(options?: VocabularyOptions): Promise<ModelVocabulary>;
  getGeometry(): Promise<ModelGeometry>;
  getProperties(expressId: ExpressId): Promise<PropertySetView[]>;
  getSpatialTree(): Promise<SpatialNodeView>;
  /** Everything the viewer can filter by, with membership. */
  getFilterFacets(): Promise<FilterFacets>;
  /** Everything the information panel shows for one element, in one read. */
  getElementInfo(expressId: ExpressId): Promise<ElementInfo>;
  /** Evaluate filters and calculated quantities in the model worker. */
  evaluateQuantityQuery(query: QuantityQuery): Promise<QuantityQueryResult>;
  /** Takes XML; parsing happens here on the main thread. */
  validateIds(
    idsXml: string,
    options?: IdsValidationOptions,
  ): Promise<IdsModelReport>;
  setEntityAttribute(
    expressId: ExpressId,
    attribute: Parameters<IfcWorkerApi["setEntityAttribute"]>[2],
    value: string,
  ): Promise<void>;
  getGeoreferencing(): Promise<GeoreferenceView>;
  setGeoreferencing(patch: GeoreferencePatch): Promise<void>;
  exportStep(options?: StepExportOptions): Promise<StepExportResult>;
  close(): Promise<void>;
};

let pool: WorkerPool<IfcWorkerApi> | null = null;

function getPool(): WorkerPool<IfcWorkerApi> {
  if (!pool) {
    pool = new WorkerPool<IfcWorkerApi>(
      () =>
        new Worker(new URL("./ifc.worker.ts", import.meta.url), {
          type: "module",
        }),
    );
  }
  return pool;
}

export type OpenModelOptions = {
  onProgress?: (progress: LoadProgress) => void;
};

/**
 * Parse a file in a worker and return a handle to it.
 *
 * `file` is read here and its bytes are transferred, not copied — after this
 * call the local `ArrayBuffer` is detached. Callers that also need the original
 * bytes (signing does: it hashes the file exactly as read) must read the file
 * again rather than reuse the buffer.
 */
export async function openModel(
  file: File,
  options: OpenModelOptions = {},
): Promise<ModelHandle> {
  const bytes = await file.arrayBuffer();
  const { api, release } = await getPool().lease();

  let summary: ModelSummary;
  try {
    summary = await api.loadModel(
      Comlink.transfer({ name: file.name, bytes }, [bytes]),
      options.onProgress ? Comlink.proxy(options.onProgress) : undefined,
    );
  } catch (error) {
    release();
    throw error;
  }

  let closed = false;

  return {
    summary,
    getEntities: (query) => api.getEntities(summary.id, query),
    getEntity: (expressId) => api.getEntity(summary.id, expressId),
    getEntityTypes: () => api.getEntityTypes(summary.id),
    getVocabulary: (options) => api.getVocabulary(summary.id, options),
    getGeometry: () => api.getGeometry(summary.id),
    getProperties: (expressId) => api.getProperties(summary.id, expressId),
    getSpatialTree: () => api.getSpatialTree(summary.id),
    getFilterFacets: () => api.getFilterFacets(summary.id),
    getElementInfo: (expressId) => api.getElementInfo(summary.id, expressId),
    evaluateQuantityQuery: (query) => api.evaluateQuantityQuery(summary.id, query),
    validateIds: (idsXml, options) =>
      api.validateIds(
        summary.id,
        // Parsed here, not in the worker: the engine's IDS parser needs
        // `DOMParser`, which a Worker does not have. The result is plain data,
        // so Comlink clones it across. See lib/ifc/ids-document.ts.
        parseIdsForEngine(idsXml),
        // Comlink cannot clone a function; it has to be proxied so the worker
        // calls back across the boundary rather than trying to serialise it.
        options?.onProgress ? Comlink.proxy(options.onProgress) : undefined,
        options?.includePassingEntities,
      ),
    setEntityAttribute: (expressId, attribute, value) =>
      api.setEntityAttribute(summary.id, expressId, attribute, value),
    getGeoreferencing: () => api.getGeoreferencing(summary.id),
    setGeoreferencing: (patch) => api.setGeoreferencing(summary.id, patch),
    exportStep: (exportOptions) => api.exportStep(summary.id, exportOptions),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await api.unloadModel(summary.id);
      } finally {
        release();
      }
    },
  };
}

/** Tear the pool down. Call on sign-out or when the last model is closed. */
export function terminateIfcWorkers() {
  pool?.terminate();
  pool = null;
}
