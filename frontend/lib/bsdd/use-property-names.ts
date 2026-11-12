"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import { loadPropertyNames, propertyLabel, propertyNameLanguage } from "./property-names";

export type PropertyTranslation = { text: string; language: string; hint: string };

/**
 * The bSDD name of a property in the interface's language, as a label for
 * `PropertyTable` — or nothing, in English, before the table has loaded, and
 * for a property outside buildingSMART's own sets (ADR 017).
 */
export function usePropertyTranslation(): (set: string | undefined, property: string) => PropertyTranslation | undefined {
  const t = useTranslations("viewer.propertyPanel");
  const language = propertyNameLanguage(useLocale());
  const { data: table } = useQuery({
    queryKey: ["property-names", language],
    enabled: language !== null,
    // No table is an error rather than data, so a panel opened later asks
    // again instead of keeping "none" for the rest of the page.
    queryFn: async () => {
      const table = await loadPropertyNames(language!);
      if (!table) throw new Error("No property names from bSDD.");
      return table;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const hint = t("translationHint");
  return useCallback((set: string | undefined, property: string) => {
    const text = propertyLabel(table, set, property);
    return text && table ? { text, language: table.language, hint } : undefined;
  }, [table, hint]);
}
