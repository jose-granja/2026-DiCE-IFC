"use client";

/**
 * What the filter panel has ticked.
 *
 * Lifted out of the panel so a project folder can save it and put it back;
 * `FacetFilterSync` applies it whether or not the panel is open.
 *
 * **Dormant ticks.** An isolation that replaces the filter (IDS, BCF, quantity
 * and clash results, the viewport's "Isolate selected") sets the filter aside
 * but leaves the ticks where they are, and they stay set aside until the user
 * changes them. `dormant` says so, so that nothing but a change of ticks — not
 * the filter facets arriving for another model, nor a project putting the same
 * ticks back after the isolation — takes that isolation away again.
 */

import { create } from "zustand";

import { emptySelection, FACET_DIMENSIONS, type FacetSelection } from "./facets";

type FacetSelectionState = {
  selection: FacetSelection;
  /** Set aside by a replacing isolation until the ticks change; see above. */
  dormant: boolean;
  /** The user's ticks: they wake a dormant filter. */
  setSelection: (next: FacetSelection | ((current: FacetSelection) => FacetSelection)) => void;
  setDormant: (dormant: boolean) => void;
  /** Ticks put back as they were saved, dormant or not. */
  restore: (selection: FacetSelection, dormant: boolean) => void;
  clear: () => void;
};

export const useFacetSelectionStore = create<FacetSelectionState>((set) => ({
  selection: emptySelection(),
  dormant: false,
  setSelection: (next) =>
    set((state) => ({ selection: typeof next === "function" ? next(state.selection) : next, dormant: false })),
  setDormant: (dormant) => set({ dormant }),
  restore: (selection, dormant) => set({ selection, dormant }),
  clear: () => set({ selection: emptySelection(), dormant: false }),
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
