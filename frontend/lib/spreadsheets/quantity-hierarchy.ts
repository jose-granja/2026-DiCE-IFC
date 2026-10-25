/**
 * The quantity list as a hierarchy — chapters, sub-chapters and the measured
 * lines under them, as a bill of quantities (MQT) is laid out.
 *
 * Each line carries a **level**, 1 at the top; the list's order says what is
 * under what: a line's children are the lines after it with a higher level, up
 * to the next one at its own level or above. Levels may skip (a 3 straight
 * under a 1); the parent is still the nearest line above with a lower level.
 *
 * A line with **no filter and no quantity** is a grouping line: a heading, never
 * run. Running it would ask for "every element, nothing measured", which is
 * not a quantity — and a filterless query with a source would count every
 * element in the model, which is why such rows used to be dropped on import.
 */

import type { QuantityQuery } from "@/lib/ifc/types";

export const MAX_QUANTITY_LEVEL = 9;

/** A level as stored or typed, as a whole number from 1 to `MAX_QUANTITY_LEVEL`. */
export function quantityLevel(value: unknown): number {
  const number = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(MAX_QUANTITY_LEVEL, Math.max(1, Math.round(number)));
}

/** The query of a grouping line: nothing to select and nothing to measure. */
export function groupQuery(): QuantityQuery {
  return {
    filters: {
      classes: [],
      predefinedTypes: [],
      objectTypes: [],
      materials: [],
      materialCategories: [],
      classificationSystem: "",
      classificationCodes: [],
      properties: [],
    },
    sources: [],
  };
}

/** True for a grouping line: no filter of any kind and no quantity. */
export function isGroupQuery(query: QuantityQuery): boolean {
  const { filters } = query;
  return (
    query.sources.length === 0 &&
    !query.formula?.trim() &&
    filters.classes.length === 0 &&
    filters.predefinedTypes.length === 0 &&
    filters.objectTypes.length === 0 &&
    filters.materials.length === 0 &&
    (filters.materialCategories ?? []).length === 0 &&
    !filters.classificationSystem?.trim() &&
    (filters.classificationCodes ?? []).length === 0 &&
    filters.properties.length === 0
  );
}

export type HierarchyLine = {
  level: number;
  /** Index of the nearest line above with a lower level, or null at the top. */
  parent: number | null;
  /** How many lines follow under this one. */
  descendants: number;
};

/** Where each line sits in the hierarchy, in list order. */
export function quantityHierarchy(items: ReadonlyArray<{ level?: number }>): HierarchyLine[] {
  const levels = items.map((item) => quantityLevel(item.level));
  const lines: HierarchyLine[] = levels.map((level) => ({ level, parent: null, descendants: 0 }));
  const open: number[] = [];
  levels.forEach((level, index) => {
    while (open.length > 0 && levels[open.at(-1)!] >= level) open.pop();
    lines[index].parent = open.at(-1) ?? null;
    for (const ancestor of open) lines[ancestor].descendants += 1;
    open.push(index);
  });
  return lines;
}

/** Indices of the lines to show: everything not under a collapsed line. */
export function visibleQuantityLines(
  items: ReadonlyArray<{ id: string; level?: number }>,
  collapsed: ReadonlySet<string>,
): number[] {
  const lines = quantityHierarchy(items);
  const shown: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    shown.push(index);
    // Skip the whole branch under a collapsed line.
    if (collapsed.has(items[index].id)) index += lines[index].descendants;
  }
  return shown;
}

/**
 * Where a new line goes, and at what level, given the one selected: under a
 * grouping line as its last child, after any other line's branch as its
 * sibling, and at the end at the top level with nothing selected.
 */
export function newLinePlacement(
  items: ReadonlyArray<{ id: string; level?: number; query: QuantityQuery }>,
  selectedId: string | null,
): { index: number; level: number } {
  const at = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
  if (at < 0) return { index: items.length, level: 1 };
  const line = quantityHierarchy(items)[at];
  const group = isGroupQuery(items[at].query);
  return {
    index: at + 1 + line.descendants,
    level: group ? Math.min(MAX_QUANTITY_LEVEL, line.level + 1) : line.level,
  };
}

/** Indices of the measured lines under a line, however deep — the grouping lines between are skipped. */
export function linesUnder(
  items: ReadonlyArray<{ id: string; level?: number; query: QuantityQuery }>,
  id: string,
): number[] {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return [];
  const { descendants } = quantityHierarchy(items)[at];
  const out: number[] = [];
  for (let index = at + 1; index <= at + descendants; index += 1) {
    if (!isGroupQuery(items[index].query)) out.push(index);
  }
  return out;
}

/**
 * Every element the lines under a grouping line select, once each, with the
 * lines that select it — an element can be in more than one (a wall measured
 * by area and by volume), and is still one element to isolate or hide.
 */
export function elementsUnder<Row extends { modelId: string; expressId: number }>(
  lines: ReadonlyArray<{ label: string; rows: readonly Row[] }>,
): Array<{ row: Row; lines: string[] }> {
  const byKey = new Map<string, { row: Row; lines: string[] }>();
  for (const line of lines) {
    for (const row of line.rows) {
      const key = `${row.modelId}#${row.expressId}`;
      const entry = byKey.get(key);
      if (!entry) byKey.set(key, { row, lines: [line.label] });
      else if (!entry.lines.includes(line.label)) entry.lines.push(line.label);
    }
  }
  return [...byKey.values()];
}
