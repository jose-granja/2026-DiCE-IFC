import type { SpatialNodeView } from "@/lib/ifc/types";
import type { EntityRef } from "./store";

/**
 * Every selectable IFC object represented by a spatial branch.
 *
 * Spatial nodes matter as well as their `elementIds`: an IfcSpace is the node
 * for a room and can also have its own geometry. A set removes duplicates from
 * exporters that repeat an occurrence at more than one hierarchy level.
 */
export function subtreeRefs(
  node: SpatialNodeView,
  modelId: string,
): EntityRef[] {
  const ids = new Set<number>();

  const visit = (current: SpatialNodeView) => {
    if (current.expressId > 0) ids.add(current.expressId);
    for (const expressId of current.elementIds) ids.add(expressId);
    for (const child of current.children) visit(child);
  };

  visit(node);
  return [...ids].map((expressId) => ({ modelId, expressId }));
}

