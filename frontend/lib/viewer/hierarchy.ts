import type { SpatialNodeView } from "@/lib/ifc/types";
import type { EntityRef } from "./store";

/**
 * Every selectable IFC object represented by a spatial branch.
 *
 * Spatial nodes matter as well as their `elementIds`: an IfcSpace is the node
 * for a room and can also have its own geometry. A set removes duplicates from
 * exporters that repeat an occurrence at more than one hierarchy level.
 *
 * The clicked node's own ref is moved to the end, after every descendant.
 * The property panel reads the *last* selected ref (`selection.at(-1)`), so
 * clicking a storey or a building in the tree must leave that node's own ref
 * last — otherwise the panel shows whatever descendant traversal happened to
 * visit last, not the storey/building the user actually clicked.
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

  if (node.expressId > 0 && ids.delete(node.expressId)) {
    ids.add(node.expressId);
  }

  return [...ids].map((expressId) => ({ modelId, expressId }));
}

