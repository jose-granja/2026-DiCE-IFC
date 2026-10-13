"use client";

/**
 * What the filter panel has ticked.
 *
 * Lifted out of the panel so a project folder can save it and put it back. The
 * panel still owns the rule that a filter does not outlive it: it clears this
 * when it unmounts, exactly as it cleared its own state before, so leaving the
 * Filters tab still never leaves the viewer hiding things with no visible
 * control to explain why.
 */

import { create } from "zustand";

import { emptySelection, FACET_DIMENSIONS, type FacetSelection } from "./facets";

type FacetSelectionState = {
  selection: FacetSelection;
  setSelection: (next: FacetSelection | ((current: FacetSelection) => FacetSelection)) => void;
  clear: () => void;
};

export const useFacetSelectionStore = create<FacetSelectionState>((set) => ({
  selection: emptySelection(),
  setSelection: (next) =>
    set((state) => ({ selection: typeof next === "function" ? next(state.selection) : next })),
  clear: () => set({ selection: emptySelection() }),
}));

/** Plain arrays, for JSON. */
export function facetSelectionToJson(selection: FacetSelection): Record<string, string[]> {
  return Object.fromEntries(
    FACET_DIMENSIONS.map((dimension) => [dimension, [...selection[dimension]].sort()]),
  );
}

export function facetSelectionFromJson(value: Partial<Record<string, string[]>>): FacetSelection {
  const selection = emptySelection();
  for (const dimension of FACET_DIMENSIONS) {
    for (const entry of value[dimension] ?? []) selection[dimension].add(entry);
  }
  return selection;
}
