"use client";

import { useCallback } from "react";
import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import { loadPropertyNames, propertyLabel, propertyNameLanguages, type PropertyNameTable } from "./property-names";

export type PropertyTranslation = { text: string; language: string; hint: string };

/** At module level, so TanStack Query reruns it only when a table changes and the hook's callback stays the same. */
const tablesOf = (results: ReadonlyArray<{ data?: PropertyNameTable }>) => results.map((result) => result.data ?? null);

/**
 * A property's bSDD name in the interface's language (Portuguese or English),
 * as a label for `PropertyTable` — when its table has loaded and the name
 * differs from the IFC one, and only in buildingSMART's own sets (ADR 017).
 */
export function usePropertyTranslation(): (set: string | undefined, property: string) => PropertyTranslation[] {
  const t = useTranslations("viewer.propertyPanel");
  const languages = propertyNameLanguages(useLocale());
  const tables = useQueries({
    queries: languages.map((language) => ({
      queryKey: ["property-names", language],
      // No table is an error rather than data, so a panel opened later asks
      // again instead of keeping "none" for the rest of the page.
      queryFn: async (): Promise<PropertyNameTable> => {
        const table = await loadPropertyNames(language);
        if (!table) throw new Error("No property names from bSDD.");
        return table;
      },
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
    combine: tablesOf,
  });
  const hint = t("translationHint");
  return useCallback((set: string | undefined, property: string) => {
    const labels: PropertyTranslation[] = [];
    for (const table of tables) {
      const text = propertyLabel(table, set, property);
      if (text && table && !labels.some((label) => label.text === text)) labels.push({ text, language: table.language, hint });
    }
    return labels;
  }, [tables, hint]);
}
