"use client";

/**
 * Run a clash matrix against the models open in the viewer.
 *
 * Three steps, each in the place that can do it cheaply:
 *   1. which elements are in each group — asked of each model's worker, which
 *      owns the parsed IFC;
 *   2. their triangles — read from the renderer, which already holds them in
 *      the shared world frame;
 *   3. the detection itself — a worker of its own, so the page stays usable.
 */

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import { detectInWorker } from "@/lib/workers/clash-client";
import { isEmptyElementFilter } from "@/lib/ifc/element-filter";
import { disciplineAllows, modelDiscipline } from "./matrix";
import type { ElementMatch } from "@/lib/ifc/types";
import type {
  ClashElementGeometry,
  ClashElementRef,
  ClashMatrix,
  ClashProgress,
  ClashResultItem,
  ClashRunResult,
  ClashTask,
} from "./types";

export class ClashRunError extends Error {}

export async function runClashMatrix(
  matrix: ClashMatrix,
  options: { onProgress?: (progress: ClashProgress) => void; signal?: AbortSignal } = {},
): Promise<ClashRunResult> {
  const started = performance.now();
  const renderer = getActiveRenderer();
  if (!renderer) throw new ClashRunError("The 3D view is not ready yet.");

  const models = useViewerStore
    .getState()
    .models.filter((model) => model.load.status === "ready");
  if (models.length === 0) throw new ClashRunError("Load at least one model first.");

  const toleranceById = new Map(matrix.tolerances.map((tolerance) => [tolerance.id, tolerance]));
  const groupById = new Map(matrix.groups.map((group) => [group.id, group]));
  const rules = matrix.rules.filter(
    (rule) =>
      toleranceById.has(rule.toleranceId) && groupById.has(rule.a) && groupById.has(rule.b),
  );
  if (rules.length === 0) throw new ClashRunError("Set at least one cell of the matrix.");

  const usedGroupIds = [...new Set(rules.flatMap((rule) => [rule.a, rule.b]))];
  for (const id of usedGroupIds) {
    const group = groupById.get(id)!;
    if (isEmptyElementFilter(group.filter)) {
      throw new ClashRunError(`Group “${group.name}” has no filter, so it would select nothing.`);
    }
  }

  // 1. Group membership.
  const refs = new Map<string, ClashElementRef>();
  const membership = new Map<string, string[]>();
  const steps = usedGroupIds.length * models.length;
  let step = 0;
  for (const id of usedGroupIds) {
    const group = groupById.get(id)!;
    const keys: string[] = [];
    for (const model of models) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ phase: "selecting", done: step, total: steps });
      step += 1;
      // A group of one discipline picks nothing from a model of another.
      if (!disciplineAllows(group.discipline, modelDiscipline(matrix, model.summary.name))) continue;
      const handle = getModelHandle(model.summary.id);
      if (!handle) continue;
      const matches: ElementMatch[] = await handle.selectElements(group.filter);
      for (const match of matches) {
        const key = `${model.summary.id}#${match.expressId}`;
        keys.push(key);
        if (!refs.has(key)) {
          refs.set(key, {
            key,
            modelId: model.summary.id,
            modelName: model.summary.name,
            expressId: match.expressId,
            type: match.type,
            name: match.name,
            globalId: match.globalId,
          });
        }
      }
    }
    membership.set(id, keys);
  }

  // 2. Geometry for every element any rule needs.
  const geometry: ClashElementGeometry[] = [];
  const withGeometry = new Set<string>();
  let withoutGeometry = 0;
  const keys = [...refs.keys()];
  for (const [index, key] of keys.entries()) {
    if (index % 200 === 0) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ phase: "geometry", done: index, total: keys.length });
      // Let the page breathe between slices of a large selection.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const ref = refs.get(key)!;
    const triangles = renderer.getElementWorldGeometry(ref);
    if (!triangles) {
      withoutGeometry += 1;
      continue;
    }
    withGeometry.add(key);
    geometry.push({ key, modelId: ref.modelId, ...triangles });
  }

  const groupCounts: Record<string, number> = {};
  for (const [id, groupKeys] of membership) {
    groupCounts[id] = groupKeys.filter((key) => withGeometry.has(key)).length;
  }

  // 3. Detection.
  const tasks: ClashTask[] = rules.map((rule, index) => {
    const tolerance = toleranceById.get(rule.toleranceId)!;
    return {
      id: `r${index}`,
      a: (membership.get(rule.a) ?? []).filter((key) => withGeometry.has(key)),
      b: (membership.get(rule.b) ?? []).filter((key) => withGeometry.has(key)),
      mode: tolerance.mode,
      horizontal: tolerance.horizontal,
      vertical: tolerance.vertical,
      clearance: tolerance.clearance,
      useVolume: tolerance.useVolume,
      volume: tolerance.volume,
    };
  });

  const { hits, truncated } = await detectInWorker(geometry, tasks, matrix.settings, {
    signal: options.signal,
    onProgress: (done, total) => options.onProgress?.({ phase: "detecting", done, total }),
  });

  const items: ClashResultItem[] = hits.map((hit, index) => {
    const rule = rules[Number(hit.taskId.slice(1))];
    return {
      ...hit,
      id: `clash-${index + 1}`,
      elementA: refs.get(hit.a)!,
      elementB: refs.get(hit.b)!,
      rule: `${groupById.get(rule.a)!.name} × ${groupById.get(rule.b)!.name}`,
      toleranceName: toleranceById.get(rule.toleranceId)!.name,
    };
  });

  return {
    items,
    truncated,
    groupCounts,
    withoutGeometry,
    durationMs: performance.now() - started,
    finishedAt: new Date().toISOString(),
  };
}
