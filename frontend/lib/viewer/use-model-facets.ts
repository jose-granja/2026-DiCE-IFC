"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { getModelHandle } from "./loader";
import { hierarchyFacets, type ModelFacets } from "./facets";
import { useViewerStore } from "./store";

/**
 * Every ready model's filter facets, one query per model so a second model
 * appearing does not refetch the first. Shared by the filter panel, which shows
 * them, and `FacetFilterSync`, which applies the ticks whether or not the panel
 * is open — the same query keys, so the work is done once.
 *
 * `enabled: false` reads only what is already cached: the sync has nothing to
 * apply until something is ticked, and a model nobody filters by should not be
 * walked for facets.
 */
export function useModelFacets(enabled = true): { facets: ModelFacets[]; loading: boolean } {
  const models = useViewerStore((s) => s.models);
  const ready = useMemo(() => models.filter((model) => model.load.status === "ready"), [models]);

  const queries = useQueries({
    queries: ready.map((model) => ({
      queryKey: ["filter-facets", model.summary.id],
      staleTime: Infinity,
      retry: false,
      enabled,
      queryFn: async (): Promise<ModelFacets> => {
        const handle = getModelHandle(model.summary.id);
        if (!handle) throw new Error("That model is no longer loaded.");
        const [facets, tree] = await Promise.all([handle.getFilterFacets(), handle.getSpatialTree()]);
        return { modelId: model.summary.id, facets, hierarchy: hierarchyFacets(tree) };
      },
    })),
  });

  // `useQueries` hands back a fresh array every render; what changes is the
  // data it holds, so that is what the memo keys on.
  const versions = queries.map((query) => `${query.dataUpdatedAt}:${query.isLoading}`).join(",");
  return useMemo(
    () => ({
      facets: queries.flatMap((query) => (query.data ? [query.data] : [])),
      loading: queries.some((query) => query.isLoading),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versions],
  );
}
