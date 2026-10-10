/**
 * The viewer-state side of `lib/pointcloud/place.ts`: which model a cloud in the
 * model frame belongs to, and what to do when it cannot be placed.
 */

import { placePointCloud, type CloudPlacementResult, type CloudTransform } from "@/lib/pointcloud/place";
import type { PointCloudEntry } from "./pointcloud-store";
import type { useViewerStore } from "./store";

type ViewerSnapshot = Pick<ReturnType<typeof useViewerStore.getState>, "models" | "worldOrigin" | "placements">;

const AT_SCENE_ORIGIN: CloudTransform = { offset: [0, 0, 0], rotationY: 0, scale: 1 };

/**
 * Where a cloud goes, and why not when it cannot be placed properly.
 *
 * A cloud that cannot be placed is still drawn — at the scene origin — rather
 * than being hidden: a cloud that vanishes with no explanation reads as a load
 * that failed. `problem` is for the list to say what is missing.
 */
export function resolveCloudTransform(
  entry: PointCloudEntry,
  viewer: ViewerSnapshot,
): { transform: CloudTransform; problem: Extract<CloudPlacementResult, { ok: false }>["reason"] | null } {
  if (!entry.cloud) return { transform: AT_SCENE_ORIGIN, problem: null };

  // The first model that has finished loading is the one a model-frame cloud is
  // registered to. A cloud rarely belongs to more than one.
  const model = viewer.models.find((candidate) => candidate.load.status === "ready" && candidate.coordinates);

  const result = placePointCloud({
    origin: entry.cloud.origin,
    frame: entry.frame,
    worldOrigin: viewer.worldOrigin,
    model: model?.coordinates
      ? {
          originShift: model.coordinates.originShift,
          placement: viewer.placements[model.summary.id] ?? null,
        }
      : null,
  });

  return result.ok
    ? { transform: result.transform, problem: null }
    : { transform: AT_SCENE_ORIGIN, problem: result.reason };
}
