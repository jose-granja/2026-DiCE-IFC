/**
 * The findings of a validation run, grouped as the panel, the BCF export and the
 * PDF report all show them: per stage in the service's order, per rule (or, for
 * the schema, per entity and attribute), errors before warnings. Pure.
 */

import { outcomeCode, VALIDATION_STAGES, type StageResult, type ValidationOutcome, type ValidationStage } from "./stages";

/** What a finding is about, which decides how it is explained (`explain.ts`). */
export type FindingKind = "header" | "schema" | "rule" | "other";

/** One finding to report: a stage, the rule (or schema message, or header field) and its occurrences. */
export type FindingGroup = {
  stage: ValidationStage;
  kind: FindingKind;
  key: string;
  /** Rule code; for the schema the rule or attribute (`IfcOwnerHistory.CorrectChangeAction`) or the message's title; for the header the field. */
  label: string;
  title: string;
  doc?: string | null;
  severity: "ERROR" | "WARNING";
  outcomes: ValidationOutcome[];
};

function kindOf(stage: ValidationStage, o: ValidationOutcome): FindingKind {
  if (o.rule) return "rule";
  if (stage === "header") return "header";
  if (stage === "schema") return "schema";
  return "other";
}

function labelOf(kind: FindingKind, stage: ValidationStage, o: ValidationOutcome): string {
  if (kind === "rule") return o.rule!;
  if (kind === "header") return String(o.feature ?? "header");
  if (kind === "schema") return o.attribute || o.title || o.type || "schema";
  return String(o.feature ?? outcomeCode(o) ?? stage);
}

/** Header fields in the order they explain each other: the originating system before what is read from it. */
const HEADER_ORDER = ["originating_system", "company_name", "application_name", "version", "time_stamp", "description", "comments"];

function compareGroups(a: FindingGroup, b: FindingGroup): number {
  if (a.severity !== b.severity) return a.severity === "ERROR" ? -1 : 1;
  if (a.kind === "header" && b.kind === "header") {
    const rank = (label: string) => (HEADER_ORDER.indexOf(label) + HEADER_ORDER.length + 1) % (HEADER_ORDER.length + 1);
    if (rank(a.label) !== rank(b.label)) return rank(a.label) - rank(b.label);
  }
  return a.label.localeCompare(b.label);
}

/** The findings to report, stage by stage in the service's order, errors before warnings. */
export function findingGroups(results: Partial<Record<ValidationStage, StageResult>>): FindingGroup[] {
  const groups: FindingGroup[] = [];
  for (const stage of VALIDATION_STAGES) {
    const result = results[stage];
    if (!result) continue;
    const byKey = new Map<string, FindingGroup>();
    for (const o of result.outcomes) {
      if (o.severity !== "ERROR" && o.severity !== "WARNING") continue;
      const kind = kindOf(stage, o);
      const label = labelOf(kind, stage, o);
      const key = `${stage}:${label}`;
      const group = byKey.get(key) ?? {
        stage, kind, key, label,
        title: kind === "rule" ? (o.title ?? label) : label,
        doc: o.doc, severity: o.severity, outcomes: [],
      };
      if (o.severity === "ERROR") group.severity = "ERROR";
      group.outcomes.push(o);
      byKey.set(key, group);
    }
    groups.push(...[...byKey.values()].sort(compareGroups));
  }
  return groups;
}

/** An outcome's expected / observed values, as one line of text. */
export function describeValue(value: unknown, limit = 300): string {
  if (value == null) return "";
  // The rules wrap a plain value as {"schema_identifier": "STANDARD"} or {"value": 3}: show the value.
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && (keys[0] === "schema_identifier" || keys[0] === "value")) {
      return describeValue((value as Record<string, unknown>)[keys[0]], limit);
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
