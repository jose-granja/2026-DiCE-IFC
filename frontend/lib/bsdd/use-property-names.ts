"use client";

import { useCallback } from "react";
import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";

import {
  attributeLabel,
  loadPropertyNames,
  propertyLabel,
  propertyNameLanguages,
  type PropertyNameTable,
} from "./property-names";

export type PropertyTranslation = { text: string; language: string; hint: string };

/** At module level, so TanStack Query reruns it only when a table changes and the hooks' callbacks stay the same. */
const tablesOf = (results: ReadonlyArray<{ data?: PropertyNameTable }>) => results.map((result) => result.data ?? null);

/** The interface language's bSDD tables, each null until it loads (or when bSDD cannot be reached). */
function useNameTables(): (PropertyNameTable | null)[] {
  const languages = propertyNameLanguages(useLocale());
  return useQueries({
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
}

function labels(
  tables: (PropertyNameTable | null)[],
  hint: string,
  label: (table: PropertyNameTable | null) => string | undefined,
): PropertyTranslation[] {
  const found: PropertyTranslation[] = [];
  for (const table of tables) {
    const text = label(table);
    if (text && table && !found.some((entry) => entry.text === text)) found.push({ text, language: table.language, hint });
  }
  return found;
}

/**
 * A property's bSDD name in the interface's language (Portuguese or English),
 * as a label for `PropertyTable` — when its table has loaded and the name
 * differs from the IFC one, and only in buildingSMART's own sets (ADR 017).
 */
export function usePropertyTranslation(): (set: string | undefined, property: string) => PropertyTranslation[] {
  const hint = useTranslations("viewer.propertyPanel")("translationHint");
  const tables = useNameTables();
  return useCallback(
    (set: string | undefined, property: string) => labels(tables, hint, (table) => propertyLabel(table, set, property)),
    [tables, hint],
  );
}

/** An entity attribute's bSDD name in the interface's language (`ObjectType` → "Tipo de Objeto"), the same way. */
export function useAttributeTranslation(): (attribute: string) => PropertyTranslation[] {
  const hint = useTranslations("viewer.propertyPanel")("attributeTranslationHint");
  const tables = useNameTables();
  return useCallback(
    (attribute: string) => labels(tables, hint, (table) => attributeLabel(table, attribute)),
    [tables, hint],
  );
}
