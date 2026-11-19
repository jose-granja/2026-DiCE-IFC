/**
 * What a validation finding means, in words (ADR 018) — the same for the panel,
 * the PDF and the BCF, so the three never explain a finding differently.
 *
 * - **Header**: what the service's header policy requires of each field
 *   (`validator/python/vendor/header_policy/validate_header.py`), and, for the
 *   company, application and version, that they are read from the originating
 *   system — so "company_name: empty" says it is because the originating system
 *   could not be split, not that a field is missing.
 * - **Schema**: "Attribute not optional" as a sentence; a WHERE rule named, with
 *   its expression and evaluation kept as detail; a type's rule by the sentence
 *   IfcOpenShell itself gives ("The attribute GlobalId should be…").
 * - **Rules**: the rule's own description from its feature file, as the service
 *   shows it.
 *
 * Pure: words through `t`, keys under `validationExplain`.
 */

import type { FindingGroup } from "./findings";
import type { ValidationOutcome } from "./stages";

export type ExplainTranslate = (key: string, values?: Record<string, string | number>) => string;

/** Header fields the policy checks by name; anything else is reported by IfcOpenShell's header check. */
const HEADER_FIELDS = ["originating_system", "company_name", "application_name", "version", "time_stamp", "description", "comments"];
const NOT_OPTIONAL = "Attribute not optional";

function text(value: unknown): string {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The group's heading. */
export function groupTitle(group: FindingGroup, t: ExplainTranslate): string {
  if (group.kind === "header") {
    return HEADER_FIELDS.includes(group.label) ? t(`header.fields.${group.label}`) : t("header.fields.other", { field: group.label });
  }
  if (group.kind === "schema") {
    const first = group.outcomes[0];
    if (first?.title === NOT_OPTIONAL && first.attribute) return t("schema.titleNotOptional", { attribute: first.attribute });
    if (first?.type === "entity_rule" || first?.type === "global_rule") return t("schema.titleRule", { rule: group.label });
  }
  return group.title;
}

/** What is required, in a sentence or two; null when there is nothing to add to the title. */
export function groupExplanation(group: FindingGroup, t: ExplainTranslate): string | null {
  const first = group.outcomes[0];
  if (!first) return null;
  if (group.kind === "header") {
    if (group.label === "description") {
      return t("header.why.description", { schema: first.schema || "?", allowed: text(first.expected) || "—" });
    }
    return HEADER_FIELDS.includes(group.label) ? t(`header.why.${group.label}`) : t("header.why.other", { field: group.label });
  }
  if (group.kind === "schema") {
    if (first.title === NOT_OPTIONAL && first.attribute) {
      const [entity, attribute] = first.attribute.split(".");
      return t("schema.notOptional", { entity, attribute: attribute ?? "" });
    }
    if (first.type === "entity_rule" || first.type === "global_rule") {
      const [entity, rule] = (first.attribute ?? "").split(".");
      return first.type === "global_rule" ? t("schema.globalRule", { rule: first.attribute ?? "" }) : t("schema.whereRule", { entity, rule: rule ?? entity });
    }
    return first.explanation ?? null;
  }
  if (group.kind === "rule") return first.description ?? null;
  return null;
}

/** What this one occurrence shows: the value found, or why it is empty. */
export function outcomeNote(outcome: ValidationOutcome, group: FindingGroup, t: ExplainTranslate): string | null {
  if (group.kind === "header") {
    const found = text(outcome.observed);
    if (!found && outcome.source !== undefined) return t("header.derived", { source: outcome.source ?? "" });
    if (group.label === "description" && outcome.reason) return descriptionNote(outcome, t);
    if (!found) return t("header.empty");
    if (group.label === "originating_system") {
      const parts = found.split(" - ").length;
      if (parts !== 3) return t("header.parts", { value: found, count: parts });
    }
    return t("header.found", { value: found });
  }
  if (group.kind === "schema") return outcome.detail ? t("schema.violatedBy", { detail: outcome.detail }) : null;
  return null;
}

/** Which of FILE_DESCRIPTION's checks failed, and on what (the driver's `reason`). */
function descriptionNote(o: ValidationOutcome, t: ExplainTranslate): string {
  const quoted = (values: string[] | null | undefined) => (values ?? []).map((v) => `“${v}”`).join(", ");
  switch (o.reason) {
    case "empty": return t("header.description.empty");
    case "unreadable": return t("header.description.unreadable", { entries: quoted(o.unreadable) });
    case "noView": return t("header.description.noView");
    case "notAllowed": return t("header.description.notAllowed", { views: quoted(o.views), schema: o.schema || "?" });
    case "addOn": return t("header.description.addOn", { views: quoted(o.views) });
    default: return t("header.description.type");
  }
}

/** Technical detail kept for whoever wants it: a rule's EXPRESS expression. */
export function outcomeTechnical(outcome: ValidationOutcome): string | null {
  return outcome.expression ?? null;
}

/** The documentation link's label. */
export function docLabel(group: FindingGroup, t: ExplainTranslate): string {
  if (group.kind === "header") return t("docs.header");
  if (group.kind === "schema") return t("docs.schema");
  return t("docs.rule");
}
