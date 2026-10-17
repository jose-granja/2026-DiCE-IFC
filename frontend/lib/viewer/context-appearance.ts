import type { ContextFeature, ContextFeatureRange } from "@/lib/georef/context-geometry";
import { paletteColour } from "@/lib/lens/palette";
import { DEFAULT_EDGE_WIDTH } from "./edges";

export type ContextColouring = {
  property: string;
  overrides: Record<string, string>;
  /** Typed property-value keys. Omitted in older projects: all values visible. */
  hiddenValues?: string[];
};
export type ContextAppearance = {
  edgesOn: boolean;
  edgeWidth: number;
  colouring: ContextColouring | null;
};

export const DEFAULT_CONTEXT_APPEARANCE: ContextAppearance = {
  edgesOn: true, edgeWidth: DEFAULT_EDGE_WIDTH, colouring: null,
};

/** Typed keys keep false, zero, empty strings and missing values distinct. */
export function contextValueKey(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function contextPropertyValue(feature: ContextFeature, property: string): unknown {
  return Object.prototype.hasOwnProperty.call(feature.properties, property) ? feature.properties[property] : undefined;
}

export function contextFeatureHidden(feature: ContextFeature | undefined, colouring: ContextColouring | null): boolean {
  return !!feature && !!colouring?.hiddenValues?.includes(contextValueKey(contextPropertyValue(feature, colouring.property)));
}

/** Keep original vertex IDs and triangle order, including surfaces without metadata. */
export function contextVisibleIndices(
  vertexCount: number, features: readonly ContextFeature[], ranges: readonly ContextFeatureRange[], colouring: ContextColouring | null,
): Uint32Array | null {
  if (!colouring?.hiddenValues?.length) return null;
  const hidden = new Set(colouring.hiddenValues);
  const hiddenRanges = ranges.filter((range) => {
    const feature = features[range.featureIndex];
    return feature && hidden.has(contextValueKey(contextPropertyValue(feature, colouring.property)));
  });
  if (!hiddenRanges.length) return null;
  const indices = new Uint32Array(vertexCount - hiddenRanges.reduce((sum, range) => sum + range.triangleCount * 3, 0));
  let cursor = 0, next = 0;
  for (const range of hiddenRanges) {
    const start = range.firstTriangle * 3;
    for (; cursor < start; cursor++) indices[next++] = cursor;
    cursor = (range.firstTriangle + range.triangleCount) * 3;
  }
  for (; cursor < vertexCount; cursor++) indices[next++] = cursor;
  return indices;
}

export type ContextColourGroup = { key: string; value: unknown; count: number; colour: string };

export function contextColourGroups(features: readonly ContextFeature[], colouring: ContextColouring): ContextColourGroup[] {
  const groups = new Map<string, ContextColourGroup>();
  for (const feature of features) {
    const value = contextPropertyValue(feature, colouring.property);
    const key = contextValueKey(value);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { key, value, count: 1, colour: "" });
  }
  return [...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map((group, index) => ({
    ...group,
    colour: /^#[\da-f]{6}$/i.test(colouring.overrides[group.key] ?? "") ? colouring.overrides[group.key]
      : group.value === undefined || group.value === null ? "#8b93a7" : paletteColour(index),
  }));
}
