"use client";

/**
 * Resolving BCF component references against the loaded models.
 *
 * BCF names elements by **IFC GlobalId** — a 22-character base64 GUID that is
 * stable across revisions. The viewer selects by `(modelId, expressId)`, which
 * is not: express ids are only unique within one file and change on every
 * re-export. Bridging the two is this file's whole job.
 *
 * ## Why an index
 *
 * The engine has no "find by GlobalId", so the only way across is to walk the
 * entities once and build a map. That is expensive enough to be worth doing
 * exactly once per model, and cheap enough afterwards that opening a viewpoint
 * is instant. The index is cached per model id and dropped when the model is
 * unloaded.
 *
 * ## Federations
 *
 * A GlobalId can legitimately resolve in more than one model — the same shared
 * grid or site exported into several discipline files. All matches are
 * returned: hiding one because another matched first is how a federated
 * viewpoint ends up isolating half of what it should.
 */

import type { EntityRef } from "@/lib/viewer/store";
import { getModelHandle } from "@/lib/viewer/loader";

/** GlobalId → express id, for one model. */
type ModelIndex = Map<string, number>;

const indexes = new Map<string, ModelIndex>();
const building = new Map<string, Promise<ModelIndex>>();

/**
 * Build (or reuse) the GlobalId index for a model.
 *
 * Concurrent callers share one build: opening a topic with several viewpoints
 * would otherwise walk the same model several times in parallel.
 */
async function indexOf(modelId: string): Promise<ModelIndex> {
  const cached = indexes.get(modelId);
  if (cached) return cached;

  const inFlight = building.get(modelId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const handle = getModelHandle(modelId);
    if (!handle) return new Map<string, number>();

    const entities = await handle.getEntities();
    const index: ModelIndex = new Map();
    for (const entity of entities) {
      if (entity.globalId) index.set(entity.globalId, entity.expressId);
    }

    indexes.set(modelId, index);
    return index;
  })().finally(() => building.delete(modelId));

  building.set(modelId, promise);
  return promise;
}

/** Drop a model's index. Called when a model is unloaded. */
export function forgetModel(modelId: string) {
  indexes.delete(modelId);
  building.delete(modelId);
}

export function forgetAllModels() {
  indexes.clear();
  building.clear();
}

export type ResolveResult = {
  /** Everything that resolved, across every model given. */
  refs: EntityRef[];
  /** GlobalIds that matched nothing. */
  missing: string[];
};

/**
 * Resolve GlobalIds to entity references across the given models.
 *
 * `missing` is not an error: a viewpoint routinely references elements from a
 * model the user has not loaded, and the honest response is to restore what can
 * be restored and say what could not.
 */
export async function resolveGlobalIds(
  globalIds: string[],
  modelIds: string[],
): Promise<ResolveResult> {
  if (globalIds.length === 0) return { refs: [], missing: [] };

  const built = await Promise.all(
    modelIds.map(async (modelId) => ({ modelId, index: await indexOf(modelId) })),
  );

  const refs: EntityRef[] = [];
  const missing: string[] = [];

  for (const globalId of globalIds) {
    let found = false;

    for (const { modelId, index } of built) {
      const expressId = index.get(globalId);
      if (expressId !== undefined) {
        refs.push({ modelId, expressId });
        found = true;
      }
    }

    if (!found) missing.push(globalId);
  }

  return { refs, missing };
}

/** The reverse: the GlobalId of a selected entity, for authoring a viewpoint. */
export async function globalIdOf(ref: EntityRef): Promise<string | null> {
  const handle = getModelHandle(ref.modelId);
  if (!handle) return null;

  const entity = await handle.getEntity(ref.expressId);
  return entity?.globalId || null;
}

export async function globalIdsOf(refs: EntityRef[]): Promise<string[]> {
  const ids = await Promise.all(refs.map(globalIdOf));
  return ids.filter((id): id is string => Boolean(id));
}
