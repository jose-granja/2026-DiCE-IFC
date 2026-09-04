"use client";

/**
 * bSDD as a second source of suggestions.
 *
 * The editor already offers what the **loaded model** contains. That is the
 * better source when it applies — those property sets demonstrably exist — but
 * it only describes one model, and an IDS is usually written before the model
 * it will check. bSDD describes what *should* exist, which is the other half.
 *
 * So the two are merged rather than swapped, and the model's own vocabulary is
 * listed first: a property this model actually has is a safer suggestion than
 * one a dictionary says it ought to.
 *
 * Suggestions are keyed on the classes a specification already names. Writing
 * "walls must have a fire rating" starts by saying IFCWALL, and from that bSDD
 * knows the 233 properties a wall can carry — which is the point at which
 * autocomplete stops being decoration.
 */

import { useQueries } from "@tanstack/react-query";

import { getClass, searchClasses, type BsddProperty } from "./client";
import { useBsddStore } from "./store";

export type BsddSuggestions = {
  /** IFC class names, e.g. `IFCWALL`. */
  classes: string[];
  propertySets: string[];
  /** Property names within a set; every known property when none is named. */
  propertiesFor: (propertySet: string) => string[];
  /** Enumerated values a property accepts, when bSDD declares them. */
  valuesFor: (propertySet: string, property: string) => string[];
  /**
   * Everything bSDD holds about one property — its data type and its URI.
   *
   * `valuesFor` answers the common case; this is for the editor's data-type and
   * URI fields, which need the property itself rather than a list of strings.
   */
  detailFor: (propertySet: string, property: string) => BsddProperty | undefined;
  /** True while any lookup is in flight, for the UI to say so. */
  loading: boolean;
};

const EMPTY: BsddSuggestions = {
  classes: [],
  propertySets: [],
  propertiesFor: () => [],
  valuesFor: () => [],
  detailFor: () => undefined,
  loading: false,
};

/**
 * Look up the classes a specification names, and everything bSDD knows of them.
 *
 * `classNames` comes from the specification's own entity facets. Nothing is
 * requested until the author has both chosen a dictionary and named a class —
 * there is no search-as-you-type here, so no stream of keystrokes leaves the
 * deployment.
 */
export function useBsddSuggestions(classNames: string[]): BsddSuggestions {
  const dictionaries = useBsddStore((s) => s.selected);
  const uris = dictionaries.map((entry) => entry.uri);

  const wanted = [...new Set(classNames.map((name) => name.trim()).filter(Boolean))];

  const lookups = useQueries({
    queries: wanted.map((name) => ({
      queryKey: ["bsdd-class", uris, name],
      enabled: uris.length > 0,
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        // Search first: an IDS names `IFCWALL`, bSDD keys on a URI.
        const matches = await searchClasses(uris, name, 5);
        const exact =
          matches.find(
            (entry) => entry.referenceCode?.toUpperCase() === name.toUpperCase(),
          ) ?? matches[0];
        if (!exact) return null;
        return getClass(exact.uri);
      },
    })),
  });

  if (uris.length === 0) return EMPTY;

  const properties: BsddProperty[] = lookups.flatMap(
    (query) => query.data?.properties ?? [],
  );

  const classes = [
    ...new Set(
      lookups
        .map((query) => query.data?.referenceCode?.toUpperCase())
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const propertySets = [
    ...new Set(
      properties
        .map((property) => property.propertySet)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();

  return {
    classes,
    propertySets,
    loading: lookups.some((query) => query.isLoading),

    propertiesFor: (propertySet: string) => {
      const inSet = propertySet
        ? properties.filter((property) => property.propertySet === propertySet)
        : properties;
      return [...new Set(inSet.map((property) => property.propertyCode))].sort();
    },

    valuesFor: (propertySet: string, property: string) => {
      const found = find(properties, propertySet, property);
      return (found?.allowedValues ?? []).map((value) => value.value || value.code);
    },

    detailFor: (propertySet: string, property: string) =>
      find(properties, propertySet, property),
  };
}

/**
 * The property a facet names, within the set it names.
 *
 * The set is matched when given: `Status` exists in several property sets with
 * different allowed values, so ignoring the set would offer the wrong ones.
 */
function find(
  properties: BsddProperty[],
  propertySet: string,
  property: string,
): BsddProperty | undefined {
  if (!property) return undefined;
  return properties.find(
    (entry) =>
      entry.propertyCode.toUpperCase() === property.toUpperCase() &&
      (!propertySet ||
        (entry.propertySet ?? "").toUpperCase() === propertySet.toUpperCase()),
  );
}

/** Model suggestions first, then anything bSDD adds that is not already there. */
export function merge(fromModel: string[], fromBsdd: string[]): string[] {
  const seen = new Set(fromModel.map((value) => value.toUpperCase()));
  return [...fromModel, ...fromBsdd.filter((value) => !seen.has(value.toUpperCase()))];
}
