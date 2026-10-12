"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import type { ModelVocabulary } from "@/lib/ifc/types";
import { getModelHandle } from "./loader";
import { useViewerStore } from "./store";

export type MergedVocabulary = {
  classes: string[];
  predefinedTypes: string[];
  objectTypes: string[];
  materials: string[];
  /** Classification systems the models declare. */
  classificationSystems: string[];
  /** Classification system → the codes found in it, across every model. */
  classificationCodes: Map<string, string[]>;
  /** Property set → the property names found in it, across every model. */
  propertySets: Map<string, string[]>;
};

/**
 * Codes to offer for a classification field: the named system's own once one is
 * given, otherwise every code in the model so the field is usable before a
 * system is picked.
 *
 * Capped, because this feeds a `<datalist>`: a classified model can carry
 * thousands of codes and they are only a hint. Shared by the clash group editor
 * and the quantity panel so the two never diverge.
 */
export function classificationCodesFor(
  // An iterable per system, so the merged map and a panel's own working set both fit.
  codes: ReadonlyMap<string, Iterable<string>>,
  system: string,
  limit = 500,
): string[] {
  const wanted = system.trim().toLocaleLowerCase();
  const found = new Set<string>();
  for (const [name, values] of codes) {
    if (wanted && name.toLocaleLowerCase() !== wanted) continue;
    for (const code of values) found.add(code);
  }
  return [...found].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

/**
 * What the open models contain, merged, for filter fields to suggest from.
 * Sampled by the engine, so it is a hint and never a limit on what a filter
 * may say.
 */
export function useModelVocabulary(): MergedVocabulary {
  const models = useViewerStore((state) => state.models);
  const ready = useMemo(() => models.filter((model) => model.load.status === "ready"), [models]);

  const queries = useQueries({
    queries: ready.map((model) => ({
      // Shared with the quantity panel, so one model is sampled once.
      queryKey: ["quantity-query-vocabulary", model.summary.id],
      staleTime: Infinity,
      retry: false,
      queryFn: async (): Promise<ModelVocabulary> => {
        const handle = getModelHandle(model.summary.id);
        if (!handle) throw new Error("Model unavailable.");
        return handle.getVocabulary({ sampleSize: 4_000 });
      },
    })),
  });

  // The query array is new every render; what changes is the data it holds.
  const versions = queries.map((query) => query.dataUpdatedAt).join(",");

  return useMemo(() => {
    const classes = new Set<string>();
    const predefinedTypes = new Set<string>();
    const objectTypes = new Set<string>();
    const materials = new Set<string>();
    const classificationSystems = new Set<string>();
    const classificationCodes = new Map<string, Set<string>>();
    const sets = new Map<string, Set<string>>();

    for (const model of ready) for (const entry of model.entityTypes) classes.add(entry.type);
    for (const query of queries) {
      const data = query.data;
      if (!data) continue;
      data.predefinedTypes.forEach((value) => predefinedTypes.add(value));
      data.objectTypes.forEach((value) => objectTypes.add(value));
      data.materials.forEach((value) => materials.add(value));
      data.classificationSystems.forEach((value) => classificationSystems.add(value));
      for (const entry of data.classificationCodes) {
        const codes = classificationCodes.get(entry.system) ?? new Set<string>();
        entry.codes.forEach((code) => codes.add(code));
        classificationCodes.set(entry.system, codes);
      }
      for (const set of data.propertySets) {
        const names = sets.get(set.name) ?? new Set<string>();
        set.properties.forEach((name) => names.add(name));
        sets.set(set.name, names);
      }
    }

    const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));
    return {
      classes: sorted(classes),
      predefinedTypes: sorted(predefinedTypes),
      objectTypes: sorted(objectTypes),
      materials: sorted(materials),
      classificationSystems: sorted(classificationSystems),
      classificationCodes: new Map(
        [...classificationCodes].map(([system, codes]) => [system, sorted(codes)]),
      ),
      propertySets: new Map([...sets].map(([name, names]) => [name, sorted(names)])),
    };
    // `queries` is read inside; `versions` stands in for its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, versions]);
}
