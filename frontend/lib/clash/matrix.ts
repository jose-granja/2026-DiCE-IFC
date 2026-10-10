/**
 * The clash matrix as data: building it, editing it, reading a cell.
 * Pure, so the rules about what a cell means are tested rather than assumed.
 */

import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import {
  DEFAULT_CLASH_SETTINGS,
  type ClashGroup,
  type ClashMatrix,
  type ClashRule,
  type ClashTolerance,
} from "./types";

let sequence = 0;
export const nextClashId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${(sequence += 1).toString(36)}`;

export function newGroup(name = "New group"): ClashGroup {
  return { id: nextClashId("grp"), name, filter: { ...EMPTY_ELEMENT_FILTER } };
}

export function newTolerance(over: Partial<ClashTolerance> = {}): ClashTolerance {
  return {
    id: nextClashId("tol"),
    name: "Tolerance",
    mode: "hard",
    horizontal: 0.01,
    vertical: 0.01,
    clearance: 0.05,
    useVolume: false,
    volume: 0.01,
    ...over,
  };
}

export function emptyMatrix(): ClashMatrix {
  return {
    groups: [],
    tolerances: [
      newTolerance({ name: "Hard 10 mm", mode: "hard", horizontal: 0.01, vertical: 0.01 }),
      newTolerance({ name: "Clearance 50 mm", mode: "clearance", clearance: 0.05 }),
    ],
    rules: [],
    settings: { ...DEFAULT_CLASH_SETTINGS },
  };
}

/** The cell between two groups is the same whichever way round it is asked. */
export function ruleKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function findRule(matrix: ClashMatrix, a: string, b: string): ClashRule | undefined {
  const key = ruleKey(a, b);
  return matrix.rules.find((rule) => ruleKey(rule.a, rule.b) === key);
}

/** Set (or, with null, clear) the cell between two groups. */
export function setRule(
  matrix: ClashMatrix,
  a: string,
  b: string,
  toleranceId: string | null,
): ClashMatrix {
  const key = ruleKey(a, b);
  const others = matrix.rules.filter((rule) => ruleKey(rule.a, rule.b) !== key);
  return {
    ...matrix,
    rules: toleranceId ? [...others, { a, b, toleranceId }] : others,
  };
}

export function removeGroup(matrix: ClashMatrix, id: string): ClashMatrix {
  return {
    ...matrix,
    groups: matrix.groups.filter((group) => group.id !== id),
    rules: matrix.rules.filter((rule) => rule.a !== id && rule.b !== id),
  };
}

export function removeTolerance(matrix: ClashMatrix, id: string): ClashMatrix {
  return { ...matrix, rules: matrix.rules.filter((rule) => rule.toleranceId !== id) , tolerances: matrix.tolerances.filter((tolerance) => tolerance.id !== id) };
}

/** Keep only what a stored or imported matrix may safely contain. */
export function sanitiseMatrix(value: unknown): ClashMatrix {
  const base = emptyMatrix();
  if (!value || typeof value !== "object") return base;
  const input = value as Partial<ClashMatrix>;

  const groups = Array.isArray(input.groups)
    ? input.groups.filter((group): group is ClashGroup => Boolean(group && typeof group.id === "string"))
    : [];
  const tolerances = Array.isArray(input.tolerances)
    ? input.tolerances
        .filter((tolerance) => Boolean(tolerance && typeof tolerance.id === "string"))
        // Saved before the volume tolerance existed: fill it in.
        .map((tolerance) => ({
          ...tolerance,
          useVolume: tolerance.useVolume ?? false,
          volume: tolerance.volume ?? 0.01,
        }))
    : base.tolerances;

  const groupIds = new Set(groups.map((group) => group.id));
  const toleranceIds = new Set(tolerances.map((tolerance) => tolerance.id));
  const rules = Array.isArray(input.rules)
    ? input.rules.filter(
        (rule) => groupIds.has(rule?.a) && groupIds.has(rule?.b) && toleranceIds.has(rule?.toleranceId),
      )
    : [];

  return {
    groups: groups.map((group) => ({
      ...group,
      filter: { ...EMPTY_ELEMENT_FILTER, ...group.filter },
    })),
    tolerances,
    rules,
    settings: { ...DEFAULT_CLASH_SETTINGS, ...(input.settings ?? {}) },
  };
}
