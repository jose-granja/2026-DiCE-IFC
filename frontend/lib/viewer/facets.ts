"use client";

/**
 * The five things a model can be filtered by, and how they combine.
 *
 * - **Hierarchy** — where it is. From the spatial tree.
 * - **Class** — what kind of thing it is. `IfcWall`.
 * - **Type** — which of that kind. The wall build-up the author defined once
 *   and reused.
 * - **Material** — what it is made of.
 * - **Group** — what it belongs to. `IfcGroup`, `IfcZone`, `IfcSystem`.
 *
 * Kept out of the component because the combining rule is the part worth
 * testing, and because it is easy to get backwards.
 */

import type { ExpressId, FilterFacets, ModelId } from "@/lib/ifc/types";

export type FacetDimension = "hierarchy" | "classes" | "types" | "materials" | "groups";

export const FACET_DIMENSIONS: FacetDimension[] = [
  "hierarchy",
  "classes",
  "types",
  "materials",
  "groups",
];

export const FACET_LABELS: Record<FacetDimension, string> = {
  hierarchy: "Hierarchy",
  classes: "Class",
  types: "Type",
  materials: "Material",
  groups: "Group",
};

/** What the user has ticked, per dimension. Empty means "no constraint". */
export type FacetSelection = Record<FacetDimension, Set<string>>;

export function emptySelection(): FacetSelection {
  return {
    hierarchy: new Set(),
    classes: new Set(),
    types: new Set(),
    materials: new Set(),
    groups: new Set(),
  };
}

export function selectionIsEmpty(selection: FacetSelection): boolean {
  return FACET_DIMENSIONS.every((d) => selection[d].size === 0);
}

/** One model's facets, plus the hierarchy the tree already knows. */
export type ModelFacets = {
  modelId: ModelId;
  facets: FilterFacets;
  /** Spatial node label → the elements under it. */
  hierarchy: Array<{ value: string; expressIds: ExpressId[] }>;
};

/**
 * Resolve a selection to the elements that survive it.
 *
 * **Union within a dimension, intersection across them.** Ticking two
 * materials means "either material"; ticking a material and a class means
 * "both". That is what every faceted filter does and what people expect —
 * intersecting within a dimension would make a second tick always narrow to
 * nothing, since an element has one class.
 *
 * A dimension with nothing ticked is not a constraint. Returns null when
 * nothing is ticked anywhere, which the store reads as "no filter" rather than
 * "hide everything".
 */
export function resolveVisible(
  models: ModelFacets[],
  selection: FacetSelection,
): Set<string> | null {
  if (selectionIsEmpty(selection)) return null;

  const visible = new Set<string>();

  for (const model of models) {
    const sources: Record<FacetDimension, Array<{ value: string; expressIds: ExpressId[] }>> = {
      hierarchy: model.hierarchy,
      classes: model.facets.classes,
      types: model.facets.types,
      materials: model.facets.materials,
      groups: model.facets.groups,
    };

    let surviving: Set<ExpressId> | null = null;

    for (const dimension of FACET_DIMENSIONS) {
      const chosen = selection[dimension];
      if (chosen.size === 0) continue;

      // Union of everything ticked in this dimension.
      const union = new Set<ExpressId>();
      for (const entry of sources[dimension]) {
        if (!chosen.has(entry.value)) continue;
        for (const id of entry.expressIds) union.add(id);
      }

      // Intersect with what earlier dimensions allowed.
      if (surviving === null) {
        surviving = union;
      } else {
        const kept = new Set<ExpressId>();
        for (const id of surviving) if (union.has(id)) kept.add(id);
        surviving = kept;
      }
    }

    if (!surviving) continue;
    for (const id of surviving) visible.add(`${model.modelId}#${id}`);
  }

  return visible;
}

/** Flatten a spatial tree into "label → elements beneath it". */
export function hierarchyFacets(
  node: {
    expressId?: ExpressId;
    name: string;
    type: string;
    elementIds: ExpressId[];
    children: unknown[];
  },
  into: Array<{ value: string; expressIds: ExpressId[] }> = [],
  depth = 0,
): Array<{ value: string; expressIds: ExpressId[] }> {
  const children = node.children as Array<typeof node>;

  // Everything beneath, not just directly contained: ticking a storey should
  // keep the storey's rooms and their contents, which is how people read a
  // tree.
  const collect = (current: typeof node): ExpressId[] => [
    ...(current.type === "IfcSpace" && current.expressId !== undefined
      ? [current.expressId]
      : []),
    ...current.elementIds,
    ...(current.children as Array<typeof node>).flatMap(collect),
  ];

  // The project node is every element, which is not a filter.
  if (depth > 0) {
    const beneath = [...new Set(collect(node))];
    if (beneath.length > 0) {
      into.push({ value: node.name || node.type, expressIds: beneath });
    }
  }

  for (const child of children) hierarchyFacets(child, into, depth + 1);
  return into;
}
