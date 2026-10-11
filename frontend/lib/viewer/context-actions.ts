/**
 * What the viewport's right-click menu can select, as pure functions.
 *
 * Kept apart from the menu so the rules — what counts as "the same class", what
 * counts as "the same floor" — are tested rather than assumed, and so they take
 * plain data rather than reaching into the store.
 */

import type { SpatialNodeView } from "@/lib/ifc/types";

export type EntityRefLike = { modelId: string; expressId: number };

/** `refKey`'s own format: `<modelId>#<expressId>`. The id is the part after the last `#`. */
export function parseRefKey(key: string): EntityRefLike | null {
  const at = key.lastIndexOf("#");
  if (at < 1) return null;
  const expressId = Number(key.slice(at + 1));
  return Number.isInteger(expressId) ? { modelId: key.slice(0, at), expressId } : null;
}

const keyOf = (ref: EntityRefLike) => `${ref.modelId}#${ref.expressId}`;

/**
 * Every shown element of the same IFC class as `target`, in every loaded model.
 *
 * "Shown": an element the user has hidden, or a class they have switched off,
 * would be selected invisibly, and the menu would report a count of things
 * nobody can see.
 */
export function sameClassRefs(
  target: EntityRefLike,
  typeByRef: ReadonlyMap<string, string>,
  isVisible: (ref: EntityRefLike) => boolean,
): EntityRefLike[] {
  const type = typeByRef.get(keyOf(target));
  if (!type) return [target];

  const matches: EntityRefLike[] = [];
  for (const [key, candidate] of typeByRef) {
    if (candidate !== type) continue;
    const ref = parseRefKey(key);
    if (ref && isVisible(ref)) matches.push(ref);
  }
  return matches;
}

export type StoreyMatch = {
  storey: Pick<SpatialNodeView, "expressId" | "name">;
  /** Every element contained in the storey, directly or through a space inside it. */
  elementIds: number[];
};

const isStorey = (node: SpatialNodeView) => node.type.toLowerCase() === "ifcbuildingstorey";

/** Everything under a node — its own elements and its descendants' — without crossing into another storey. */
function elementsUnder(node: SpatialNodeView, into: Set<number>) {
  for (const id of node.elementIds) into.add(id);
  for (const child of node.children) {
    if (!isStorey(child)) elementsUnder(child, into);
  }
}

/** The storey that contains an element, with all its contents; null for one outside any storey (a site element, say). */
export function storeyOf(tree: SpatialNodeView | null, expressId: number): StoreyMatch | null {
  if (!tree) return null;

  const visit = (node: SpatialNodeView): StoreyMatch | null => {
    if (isStorey(node)) {
      const ids = new Set<number>();
      elementsUnder(node, ids);
      return ids.has(expressId) ? { storey: node, elementIds: [...ids] } : null;
    }
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(tree);
}

/** Every shown element on the same storey as `target`, in the same model. */
export function sameStoreyRefs(
  target: EntityRefLike,
  tree: SpatialNodeView | null,
  typeByRef: ReadonlyMap<string, string>,
  isVisible: (ref: EntityRefLike) => boolean,
): { storeyName: string; refs: EntityRefLike[] } | null {
  const match = storeyOf(tree, target.expressId);
  if (!match) return null;

  const refs = match.elementIds
    .map((expressId) => ({ modelId: target.modelId, expressId }))
    // Only what is drawn: the tree also lists elements with no geometry.
    .filter((ref) => typeByRef.has(keyOf(ref)) && isVisible(ref));
  return { storeyName: match.storey.name, refs };
}
