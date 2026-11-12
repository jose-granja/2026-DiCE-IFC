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

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import {
  getClassPredefinedTypes,
  getClassProperties,
  getPropertyAllowedValues,
  searchClasses,
  type BsddProperty,
} from "./client";
import { useBsddStore } from "./store";

export type BsddSuggestions = {
  /** IFC class names, e.g. `IFCWALL`. */
  classes: string[];
  /** Standard predefined types for one exact IFC class. */
  predefinedTypesFor: (ifcClass: string) => string[];
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
  predefinedTypesFor: () => [],
  propertySets: [],
  propertiesFor: () => [],
  valuesFor: () => [],
  detailFor: () => undefined,
  loading: false,
};

/**
 * Look up the classes a specification names, and everything bSDD knows of them.
 *
 * `classNames` comes from the specification's own entity facets. Partial input
 * is debounced, and properties are requested only after the search has found
 * an exact class. This keeps ordinary typing from becoming a burst of bSDD
 * requests while still offering class matches from the search response.
 */
export function useBsddSuggestions(
  classNames: string[],
  {
    loadProperties,
    predefinedTypeClasses,
  }: {
    loadProperties: boolean;
    predefinedTypeClasses: string[];
  },
): BsddSuggestions {
  const dictionaries = useBsddStore((s) => s.selected);
  const uris = dictionaries.map((entry) => entry.uri);

  const namesKey = JSON.stringify(
    [...new Set(classNames.map((name) => name.trim()).filter(Boolean))],
  );
  const [debouncedNamesKey, setDebouncedNamesKey] = useState(namesKey);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedNamesKey(namesKey), 400);
    return () => window.clearTimeout(timeout);
  }, [namesKey]);

  const wanted = useMemo(
    () => JSON.parse(debouncedNamesKey) as string[],
    [debouncedNamesKey],
  );

  const searches = useQueries({
    queries: wanted.map((name) => ({
      queryKey: ["bsdd-class-search", uris, name],
      enabled: uris.length > 0,
      staleTime: Infinity,
      retry: false,
      queryFn: ({ signal }) => searchClasses(uris, name, 20, signal),
    })),
  });

  const exactClasses = searches.flatMap((query, index) => {
    const name = wanted[index];
    if (!name) return [];
    const exact = query.data?.find(
      (entry) => entry.referenceCode?.toUpperCase() === name.toUpperCase(),
    );
    return exact ? [exact] : [];
  });

  const propertyLookups = useQueries({
    queries: (loadProperties ? exactClasses : []).map((entry) => ({
      queryKey: ["bsdd-class-properties", entry.uri],
      staleTime: Infinity,
      retry: false,
      queryFn: ({ signal }) => getClassProperties(entry.uri, signal),
    })),
  });

  const wantedPredefinedTypes = new Set(
    predefinedTypeClasses.map((name) => name.trim().toUpperCase()),
  );
  const predefinedClasses = exactClasses.filter((entry) =>
    wantedPredefinedTypes.has(entry.referenceCode.toUpperCase()),
  );
  const predefinedTypeLookups = useQueries({
    queries: predefinedClasses.map((entry) => ({
      queryKey: ["bsdd-class-predefined-types", entry.uri],
      staleTime: Infinity,
      retry: false,
      queryFn: ({ signal }) =>
        getClassPredefinedTypes(entry.uri, entry.referenceCode, signal),
    })),
  });

  const properties: BsddProperty[] = propertyLookups.flatMap(
    (query) => query.data ?? [],
  );

  if (uris.length === 0) return EMPTY;

  const classes = [
    ...new Set(
      searches
        .flatMap((query) => query.data ?? [])
        .map((entry) => entry.referenceCode?.toUpperCase())
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
    predefinedTypesFor: (ifcClass: string) => {
      const index = predefinedClasses.findIndex(
        (entry) =>
          entry.referenceCode.toUpperCase() === ifcClass.trim().toUpperCase(),
      );
      return index < 0 ? [] : (predefinedTypeLookups[index]?.data ?? []);
    },
    propertySets,
    loading:
      searches.some((query) => query.isLoading) ||
      propertyLookups.some((query) => query.isLoading) ||
      predefinedTypeLookups.some((query) => query.isLoading),

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
 * The values bSDD says `property` accepts: the class listing's own, else its
 * dictionary-level definition's.
 *
 * IFC 4.3's class listing in bSDD stopped carrying allowed values — `Status`
 * on `IfcWall` lists none — while `.../prop/Status` still has NEW, EXISTING,
 * DEMOLISH… So when the class has none, the one property the facet names is
 * asked for, once, and only then.
 */
export function useBsddPropertyValues(property: BsddProperty | undefined): string[] {
  const own = property?.allowedValues ?? [];
  const uri = own.length === 0 ? property?.propertyUri : undefined;
  const { data } = useQuery({
    queryKey: ["bsdd-property-values", uri],
    enabled: Boolean(uri),
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => getPropertyAllowedValues(uri!, signal),
  });
  const values = own.length > 0 ? own : (uri ? (data ?? []) : []);
  return values.map((value) => value.value || value.code);
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
