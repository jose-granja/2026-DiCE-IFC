import type { ContextFeature } from "@/lib/georef/context-geometry";
import { paletteColour } from "@/lib/lens/palette";
import { DEFAULT_EDGE_WIDTH } from "./edges";

export type ContextColouring = { property: string; overrides: Record<string, string> };
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
