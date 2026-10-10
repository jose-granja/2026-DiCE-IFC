/// <reference lib="webworker" />

/**
 * The IFC worker.
 *
 * Everything expensive — parsing, property extraction, STEP export — happens
 * here so the UI thread survives a 200 MB model. The worker owns the parsed
 * store; the main thread only ever holds a `ModelId` and plain data.
 *
 * This is also a privacy boundary worth naming: a Worker has `fetch`, so
 * nothing structural stops a payload leaving from here. The rule in
 * AGENTS.md §1 is what stops it, and this file must never gain a network call.
 */

import * as Comlink from "comlink";

import type { EngineIdsDocument } from "@/lib/ifc/ids-document";

import { getIfcAdapter } from "@/lib/ifc/adapter";
import type {
  EditableAttribute,
  ElementFilter,
  EntityQuery,
  ExpressId,
  GeoreferencePatch,
  LoadModelInput,
  LoadProgress,
  ModelId,
  QuantityQuery,
  StepExportOptions,
  VocabularyOptions,
  IdsValidationProgress,
} from "@/lib/ifc/types";

const adapter = getIfcAdapter();

/**
 * The worker's API.
 *
 * Callbacks have to be wrapped in `Comlink.proxy()` by the caller, which is why
 * `loadModel` takes them as an explicit, optional parameter rather than inside
 * an options bag — a proxied function buried in a structured-clone payload
 * silently fails to transfer.
 */
const api = {
  engineId: adapter.engineId,

  async loadModel(
    input: LoadModelInput,
    onProgress?: (progress: LoadProgress) => void,
  ) {
    return adapter.loadModel(input, {
      onProgress: onProgress ? (p) => onProgress(p) : undefined,
    });
  },

  unloadModel(modelId: ModelId) {
    return adapter.unloadModel(modelId);
  },

  getEntities(modelId: ModelId, query?: EntityQuery) {
    return adapter.getEntities(modelId, query);
  },

  getEntity(modelId: ModelId, expressId: ExpressId) {
    return adapter.getEntity(modelId, expressId);
  },

  getEntityTypes(modelId: ModelId) {
    return adapter.getEntityTypes(modelId);
  },

  getVocabulary(modelId: ModelId, options?: VocabularyOptions) {
    return adapter.getVocabulary(modelId, options);
  },

  getProperties(modelId: ModelId, expressId: ExpressId) {
    return adapter.getProperties(modelId, expressId);
  },

  getSpatialTree(modelId: ModelId) {
    return adapter.getSpatialTree(modelId);
  },

  getFilterFacets(modelId: ModelId) {
    return adapter.getFilterFacets(modelId);
  },

  getElementInfo(modelId: ModelId, expressId: ExpressId) {
    return adapter.getElementInfo(modelId, expressId);
  },

  getMaterialInfo(modelId: ModelId, materialExpressId: ExpressId) {
    return adapter.getMaterialInfo(modelId, materialExpressId);
  },

  selectElements(modelId: ModelId, filter: ElementFilter) {
    return adapter.selectElements(modelId, filter);
  },

  evaluateQuantityQuery(modelId: ModelId, query: QuantityQuery) {
    return adapter.evaluateQuantityQuery(modelId, query);
  },

  /**
   * Validation runs here rather than on the UI thread because it is pure CPU
   * over every entity in the model — on the main thread it freezes the page for
   * the whole run, progress bar included.
   *
   * The document arrives already parsed: this side has no `DOMParser`, so
   * `ifc-client.ts` parses it on the main thread first. See
   * `lib/ifc/ids-document.ts`.
   *
   * `onProgress` must be wrapped in `Comlink.proxy()` by the caller, like
   * `loadModel`'s.
   */
  validateIds(
    modelId: ModelId,
    document: EngineIdsDocument,
    onProgress?: (progress: IdsValidationProgress) => void,
    includePassingEntities?: boolean,
  ) {
    return adapter.validateIds(modelId, document, {
      includePassingEntities,
      onProgress: onProgress ? (p) => onProgress(p) : undefined,
    });
  },

  async getGeometry(modelId: ModelId) {
    const geometry = await adapter.getGeometry(modelId);

    // Copy every mesh buffer before transferring it.
    //
    // The engine hands back typed arrays that are VIEWS INTO THE WASM HEAP —
    // several meshes share one underlying ArrayBuffer. Transferring those
    // detaches the WASM instance's memory, which kills this worker mid-call:
    // the symptom is not an error but a promise that never settles, because the
    // worker dies before it can reply ("Connection closed" on the next call).
    //
    // `slice()` gives us buffers we own, which are safe to transfer. It costs
    // one extra copy of the geometry inside the worker, which is the price of
    // not copying it again across the boundary — and the copies are released as
    // soon as they are transferred.
    const meshes = geometry.meshes.map((mesh) => ({
      ...mesh,
      positions: mesh.positions.slice(),
      normals: mesh.normals.slice(),
      indices: mesh.indices.slice(),
    }));

    const transfers = meshes.flatMap((mesh) => [
      mesh.positions.buffer as ArrayBuffer,
      mesh.normals.buffer as ArrayBuffer,
      mesh.indices.buffer as ArrayBuffer,
    ]);

    return Comlink.transfer({ ...geometry, meshes }, transfers);
  },

  setEntityAttribute(
    modelId: ModelId,
    expressId: ExpressId,
    attribute: EditableAttribute,
    value: string,
  ) {
    return adapter.setEntityAttribute(modelId, expressId, attribute, value);
  },

  getGeoreferencing(modelId: ModelId) {
    return adapter.getGeoreferencing(modelId);
  },

  setGeoreferencing(modelId: ModelId, patch: GeoreferencePatch) {
    return adapter.setGeoreferencing(modelId, patch);
  },

  async exportStep(modelId: ModelId, options?: StepExportOptions) {
    const result = await adapter.exportStep(modelId, options);
    // Transfer the bytes instead of cloning them — a 200 MB export copied
    // across the boundary would double peak memory for no reason.
    return Comlink.transfer(result, [result.content.buffer as ArrayBuffer]);
  },
};

export type IfcWorkerApi = typeof api;

Comlink.expose(api);
