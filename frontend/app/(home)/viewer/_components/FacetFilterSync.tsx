"use client";

/**
 * Applies the filter panel's ticks to the viewport, whether or not the panel
 * is open.
 *
 * It used to be the panel's own effect, cleared when the panel unmounted, so
 * that a filter could never hide things with no visible control to explain
 * why. That also meant a filter could not survive opening the Geo tab, and a
 * project could not save one alongside the 3D world context. The filter now
 * outlives the panel, and the panel's tab shows a badge while it is on — the
 * visible control is still there, one click away.
 */

import { useEffect } from "react";

import { resolveVisible, selectionIsEmpty } from "@/lib/viewer/facets";
import { useFacetSelectionStore } from "@/lib/viewer/facet-selection-store";
import { useModelFacets } from "@/lib/viewer/use-model-facets";
import { useViewerStore } from "@/lib/viewer/store";

export function FacetFilterSync() {
  const selection = useFacetSelectionStore((s) => s.selection);
  const modelCount = useViewerStore((s) => s.models.length);
  const { facets } = useModelFacets(!selectionIsEmpty(selection));

  useEffect(() => {
    useViewerStore.getState().setFacetVisible(resolveVisible(facets, selection));
  }, [facets, selection]);

  // Ticks with nothing left to filter would leave the badge on for ever.
  useEffect(() => {
    if (modelCount === 0) useFacetSelectionStore.getState().clear();
  }, [modelCount]);

  return null;
}

export default FacetFilterSync;
