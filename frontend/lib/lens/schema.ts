/**
 * Lenses read from somewhere else — this browser's storage, a project folder —
 * are checked before they are used: a rule's filter goes straight to the
 * element matcher and its colour into the renderer, and a malformed one should
 * be refused, not crash either.
 */

import { z } from "zod";

import type { Lens } from "./types";

const text = z.string().max(10_000);
const textList = z.array(text).max(10_000);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const elementFilterSchema = z.object({
  classes: textList,
  names: textList,
  predefinedTypes: textList,
  objectTypes: textList,
  materials: textList,
  materialCategories: textList,
  classificationSystem: text.optional(),
  classificationCodes: textList.optional(),
  propertyCombination: z.enum(["all", "any"]).optional(),
  properties: z
    .array(
      z.object({
        setName: text,
        propertyName: text,
        operator: z.enum([
          "equals",
          "notEquals",
          "contains",
          "greaterThan",
          "greaterOrEqual",
          "lessThan",
          "lessOrEqual",
          "exists",
        ]),
        value: text,
      }),
    )
    .max(1_000),
});

const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("class") }),
  z.object({ kind: z.literal("objectType") }),
  z.object({ kind: z.literal("predefinedType") }),
  z.object({ kind: z.literal("material") }),
  z.object({ kind: z.literal("group") }),
  z.object({ kind: z.literal("storey") }),
  z.object({ kind: z.literal("model") }),
  z.object({ kind: z.literal("classification"), system: text.optional() }),
  z.object({ kind: z.literal("property"), setName: text, propertyName: text }),
]);

const base = {
  id: z.string().min(1).max(200),
  name: text,
  description: text.optional(),
  unmatched: z.enum(["ghost", "keep", "hide"]).default("ghost"),
};

export const lensSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("rules"),
    rules: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          name: text,
          enabled: z.boolean().default(true),
          filter: elementFilterSchema,
          action: z.enum(["colour", "hide", "transparent"]),
          colour,
        }),
      )
      .max(200),
  }),
  z.object({ ...base, kind: z.literal("auto"), source }),
]);

export const lensListSchema = z.array(lensSchema).max(500);

/** The lenses in `value` that are valid, dropping the rest — for local storage, where one bad entry must not lose the others. */
export function sanitiseLenses(value: unknown): Lens[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const result = lensSchema.safeParse(entry);
    return result.success ? [result.data as Lens] : [];
  });
}
