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
    modelDisciplines: {},
  };
}

/** A discipline as compared: case and surrounding spaces do not count. */
export const disciplineKey = (value: string | undefined) => (value ?? "").trim().toLocaleLowerCase();

/** A model's discipline, as classified in the matrix; empty when it has none. */
export function modelDiscipline(matrix: ClashMatrix, modelName: string): string {
  return (matrix.modelDisciplines?.[modelName] ?? "").trim();
}

/**
 * Whether a group may pick elements from a model. Only when both say a
 * discipline do they have to agree (ignoring case): an unclassified model is
 * tested by every group, and a group with no discipline picks from every model.
 */
export function disciplineAllows(groupDiscipline: string | undefined, modelDisciplineValue: string | undefined): boolean {
  const group = disciplineKey(groupDiscipline);
  const model = disciplineKey(modelDisciplineValue);
  return !group || !model || group === model;
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
    modelDisciplines: sanitiseDisciplines(input.modelDisciplines),
  };
}

/** Model name → discipline, keeping only real text on both sides. */
function sanitiseDisciplines(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, discipline] of Object.entries(value as Record<string, unknown>)) {
    if (typeof discipline !== "string" || !name.trim() || !discipline.trim()) continue;
    out[name] = discipline.trim().slice(0, 200);
  }
  return out;
}
