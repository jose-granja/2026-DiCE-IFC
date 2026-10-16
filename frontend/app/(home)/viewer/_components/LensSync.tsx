"use client";

/**
 * Applies the lens on screen to the viewport, whichever tab is open.
 *
 * Asks each model's worker what the lens needs — which elements each rule
 * picks, or every element's value for an auto-colour lens — evaluates the lens
 * (`lib/lens/evaluate.ts`) and hands the result to the viewer store, which the
 * canvas draws. Always mounted, like `FacetFilterSync`: a lens is a way of
 * looking at the model, and it stays on while another panel is used.
 *
 * Worker answers are cached on what changes them — a rule's *filter*, the
 * source — not on colours or names, so recolouring a rule, renaming it or
 * switching a legend entry off is instant and asks no worker anything.
 */

import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { evaluateLens, type LensInput } from "@/lib/lens/evaluate";
import { shownLens, useLensStore } from "@/lib/lens/store";
import type { Lens } from "@/lib/lens/types";
import { getModelHandle } from "@/lib/viewer/loader";
import { refKey, useViewerStore } from "@/lib/viewer/store";
import { isEmptyElementFilter } from "@/lib/ifc/element-filter";

type ModelAnswer = {
  modelId: string;
  universe: number[];
  /** Rules: what each enabled rule selected, by rule id. */
  matches?: Array<{ ruleId: string; ids: number[] }>;
  /** Auto: each value's elements. */
  groups?: Array<{ value: string; ids: number[] }>;
};

/** What the worker's answer depends on — and nothing else. */
function workerKey(lens: Lens): string {
  if (lens.kind === "auto") return JSON.stringify(["auto", lens.source]);
  return JSON.stringify([
    "rules",
    lens.rules.filter((rule) => rule.enabled).map((rule) => [rule.id, rule.filter]),
  ]);
}

export function LensSync() {
  const lens = useLensStore((s) => shownLens(s));
  const hiddenLegend = useLensStore((s) => s.hiddenLegend);
  const models = useViewerStore((s) => s.models);
  const ready = useMemo(() => models.filter((model) => model.load.status === "ready"), [models]);

  useEffect(() => {
    useLensStore.getState().hydrate();
  }, []);

  const key = lens ? workerKey(lens) : null;
  const queries = useQueries({
    queries: ready.map((model) => ({
      queryKey: ["lens", model.summary.id, key],
      enabled: Boolean(lens),
      staleTime: Infinity,
      retry: false,
      queryFn: async (): Promise<ModelAnswer> => {
        const handle = getModelHandle(model.summary.id);
        if (!handle || !lens) throw new Error("That model is no longer loaded.");
        // Every placed element, once per model: the class facet already lists them.
        const classes = await handle.groupElementsByValue({ kind: "class" });
        const universe = classes.flatMap((group) => group.expressIds);
        if (lens.kind === "rules") {
          const matches: ModelAnswer["matches"] = [];
          for (const rule of lens.rules) {
            if (!rule.enabled) continue;
            // An empty filter selects nothing, not everything (`isEmptyElementFilter`).
            const ids = isEmptyElementFilter(rule.filter)
              ? []
              : (await handle.selectElements(rule.filter)).map((match) => match.expressId);
            matches.push({ ruleId: rule.id, ids });
          }
          return { modelId: model.summary.id, universe, matches };
        }
        if (lens.source.kind === "model") {
          return { modelId: model.summary.id, universe, groups: [{ value: model.summary.name, ids: universe }] };
        }
        if (lens.source.kind === "class") {
          return {
            modelId: model.summary.id,
            universe,
            groups: classes.map((group) => ({ value: group.value, ids: group.expressIds })),
          };
        }
        const groups = await handle.groupElementsByValue(lens.source);
        return {
          modelId: model.summary.id,
          universe,
          groups: groups.map((group) => ({ value: group.value, ids: group.expressIds })),
        };
      },
    })),
  });

  // `useQueries` returns a fresh array each render; the data is what changes.
  const versions = queries.map((query) => `${query.dataUpdatedAt}:${query.status}`).join(",");
  const answers = useMemo(
    () => queries.flatMap((query) => (query.data ? [query.data] : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versions],
  );
  const loading = queries.some((query) => query.isLoading);
  const failure = queries.find((query) => query.error)?.error;

  useEffect(() => {
    const store = useLensStore.getState();
    if (!lens) {
      useViewerStore.getState().setLensView(null);
      store.setResult("idle", []);
      return;
    }
    if (failure) {
      useViewerStore.getState().setLensView(null);
      store.setResult("failed", [], failure instanceof Error ? failure.message : String(failure));
      return;
    }
    if (loading || answers.length < ready.length) {
      store.setResult("running", store.legend);
      return;
    }

    const ref = (modelId: string, expressId: number) => refKey({ modelId, expressId });
    const universe = answers.flatMap((answer) => answer.universe.map((id) => ref(answer.modelId, id)));
    let input: LensInput;
    if (lens.kind === "rules") {
      input = {
        kind: "rules",
        universe,
        matches: lens.rules
          .filter((rule) => rule.enabled)
          .map((rule) => ({
            ruleId: rule.id,
            refs: answers.flatMap((answer) =>
              (answer.matches?.find((match) => match.ruleId === rule.id)?.ids ?? []).map((id) =>
                ref(answer.modelId, id),
              ),
            ),
          })),
      };
    } else {
      // One legend entry per value across the federation, not per model.
      const merged = new Map<string, string[]>();
      for (const answer of answers) {
        for (const group of answer.groups ?? []) {
          const refs = merged.get(group.value) ?? [];
          for (const id of group.ids) refs.push(ref(answer.modelId, id));
          merged.set(group.value, refs);
        }
      }
      input = { kind: "auto", universe, groups: [...merged].map(([value, refs]) => ({ value, refs })) };
    }

    const result = evaluateLens(lens, input, hiddenLegend);
    useViewerStore.getState().setLensView(result.view);
    store.setResult("ready", result.legend);
  }, [lens, answers, loading, failure, ready.length, hiddenLegend]);

  // Leaving the viewer takes the lens's colours with it; coming back recomputes.
  useEffect(() => () => useViewerStore.getState().setLensView(null), []);

  return null;
}

export default LensSync;
