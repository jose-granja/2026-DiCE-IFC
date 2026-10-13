/**
 * Aggregating IDS results across a federation.
 *
 * The engine validates **one model at a time** — it has no notion of a
 * federation, and neither does IDS itself. But a coordinator asks "does the
 * project satisfy this specification?", not "does the architectural model".
 * So results are merged here, and the merge is where the interesting decisions
 * are.
 *
 * ## How a specification's status combines
 *
 * A specification is `not_applicable` only when **no** model had a single
 * applicable entity. If any model found applicable entities, the specification
 * applies to the project, and it fails if any of them failed. The alternative —
 * treating a model with no matching entities as a pass — would let a
 * specification report green because the discipline that owns it was not
 * loaded.
 *
 * Pure and engine-free, so it is testable without a WASM parser.
 */

import type {
  IdsModelReport,
  IdsRequirementResultView,
  IdsRequirementView,
  IdsSpecificationResultView,
} from "@/lib/ifc/types";

export type FailureStatus = "fail";

/** One failing entity, flattened out of the per-model, per-specification tree. */
export type Failure = {
  /**
   * Stable across runs of the same report: the BCF export uses it to keep a
   * topic's identity when a report is re-exported, and React uses it as a key.
   */
  id: string;
  modelId: string;
  modelName: string;
  expressId: number;
  /** Absent on unrooted entities, which cannot be referenced from a viewpoint. */
  globalId?: string;
  type: string;
  name?: string;
  specificationIndex: number;
  specificationName: string;
  /** Only the requirements that actually failed. */
  requirements: IdsRequirementResultView[];
};

export type PerModelResult = {
  modelId: string;
  modelName: string;
  status: "pass" | "fail" | "not_applicable";
  applicableCount: number;
  passedCount: number;
  failedCount: number;
};

/**
 * One requirement of a specification, across the federation: what it checks,
 * how many applicable elements passed and failed it, and which failed.
 *
 * The breakdown a coordinator reads first — "FireRating is missing on 40
 * walls" — where the per-element list answers "what is wrong with this wall".
 */
export type RequirementBreakdown = IdsRequirementView & {
  failedCount: number;
  passedCount: number;
  /** The failing elements, each carrying only the reason for *this* requirement. */
  failures: Failure[];
};

export type AggregatedSpecification = {
  index: number;
  name: string;
  description?: string;
  status: "pass" | "fail" | "not_applicable";
  applicableCount: number;
  passedCount: number;
  failedCount: number;
  /** 0–100. 100 when nothing was applicable. */
  passRate: number;
  failures: Failure[];
  /** Every requirement, in document order, with its own pass/fail counts. */
  requirements: RequirementBreakdown[];
  perModel: PerModelResult[];
  cardinality?: { passed: boolean; message: string; modelName: string };
};

export type ValidationRun = {
  idsTitle: string;
  startedAt: string;
  finishedAt: string;
  models: Array<{
    modelId: string;
    name: string;
    schemaVersion: string;
    entityCount: number;
  }>;
  specifications: AggregatedSpecification[];
  summary: {
    totalSpecifications: number;
    passed: number;
    failed: number;
    notApplicable: number;
    /** Distinct entities that failed at least one specification. */
    failingEntities: number;
    totalChecks: number;
    passRate: number;
  };
};

export type ModelIdentity = { modelId: string; name: string };

/**
 * Merge per-model reports into one federation-wide run.
 *
 * Specifications are joined on `index`, not on `name`: two specifications may
 * legitimately share a name, and the index is the document's own identity for
 * them.
 */
export function aggregate(
  reports: IdsModelReport[],
  models: ModelIdentity[],
  meta: { idsTitle: string; startedAt: string; finishedAt: string },
): ValidationRun {
  const nameOf = new Map(models.map((model) => [model.modelId, model.name]));
  const byIndex = new Map<number, AggregatedSpecification>();

  for (const report of reports) {
    const modelName = nameOf.get(report.modelId) ?? report.modelId;

    for (const specification of report.specifications) {
      const existing = byIndex.get(specification.index) ?? blank(specification);
      byIndex.set(specification.index, merge(existing, specification, report.modelId, modelName));
    }
  }

  const specifications = [...byIndex.values()].sort((a, b) => a.index - b.index);
  for (const specification of specifications) finalise(specification);

  return {
    idsTitle: meta.idsTitle,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    models: reports.map((report) => ({
      modelId: report.modelId,
      name: nameOf.get(report.modelId) ?? report.modelId,
      schemaVersion: report.schemaVersion,
      entityCount: report.entityCount,
    })),
    specifications,
    summary: summarise(specifications),
  };
}

function blank(specification: IdsSpecificationResultView): AggregatedSpecification {
  return {
    index: specification.index,
    name: specification.name,
    description: specification.description,
    status: "not_applicable",
    applicableCount: 0,
    passedCount: 0,
    failedCount: 0,
    passRate: 100,
    failures: [],
    // Every model was validated against the same document, so the first
    // report's list is the list.
    requirements: (specification.requirements ?? []).map((requirement) => ({
      ...requirement,
      label: tidy(requirement.label),
      failedCount: 0,
      passedCount: 0,
      failures: [],
    })),
    perModel: [],
  };
}

function merge(
  aggregated: AggregatedSpecification,
  specification: IdsSpecificationResultView,
  modelId: string,
  modelName: string,
): AggregatedSpecification {
  const failures: Failure[] = specification.entities
    .filter((entity) => !entity.passed)
    .map((entity) => ({
      id: `${modelId}:${entity.expressId}:${specification.index}`,
      modelId,
      modelName,
      expressId: entity.expressId,
      globalId: entity.globalId,
      type: entity.type,
      name: entity.name,
      specificationIndex: specification.index,
      specificationName: specification.name,
      requirements: entity.requirements.filter(
        (requirement) => requirement.status === "fail",
      ),
    }));

  return {
    ...aggregated,
    applicableCount: aggregated.applicableCount + specification.applicableCount,
    passedCount: aggregated.passedCount + specification.passedCount,
    failedCount: aggregated.failedCount + specification.failedCount,
    failures: [...aggregated.failures, ...failures],
    perModel: [
      ...aggregated.perModel,
      {
        modelId,
        modelName,
        status: specification.status,
        applicableCount: specification.applicableCount,
        passedCount: specification.passedCount,
        failedCount: specification.failedCount,
      },
    ],
    // A cardinality failure in any model is the one worth showing.
    cardinality:
      aggregated.cardinality?.passed === false
        ? aggregated.cardinality
        : specification.cardinality
          ? { ...specification.cardinality, modelName }
          : aggregated.cardinality,
  };
}

function finalise(specification: AggregatedSpecification) {
  const cardinalityFailed = specification.cardinality?.passed === false;

  specification.status =
    specification.applicableCount === 0 && !cardinalityFailed
      ? "not_applicable"
      : specification.failedCount > 0 || cardinalityFailed
        ? "fail"
        : "pass";

  specification.passRate =
    specification.applicableCount === 0
      ? 100
      : (specification.passedCount / specification.applicableCount) * 100;

  // Regroup the failing elements by requirement. Every applicable element is
  // checked against every requirement, so what did not fail one passed it.
  const byId = new Map(specification.requirements.map((requirement) => [requirement.id, requirement]));
  for (const failure of specification.failures) {
    for (const requirement of failure.requirements) {
      const key = requirement.requirementId ?? `unlisted:${requirement.description}`;
      let group = byId.get(key);
      if (!group) {
        // A result naming a requirement the document list did not: kept, not dropped.
        group = {
          id: key,
          label: tidy(requirement.description),
          optionality: "required",
          failedCount: 0,
          passedCount: 0,
          failures: [],
        };
        byId.set(key, group);
        specification.requirements.push(group);
      }
      group.failures.push({ ...failure, requirements: [requirement] });
    }
  }
  for (const group of specification.requirements) {
    group.failedCount = group.failures.length;
    group.passedCount = Math.max(0, specification.applicableCount - group.failedCount);
  }
}

function summarise(specifications: AggregatedSpecification[]) {
  // Distinct entities: one element failing four specifications is one thing to
  // go and fix, and reporting it as four overstates the work.
  const entities = new Set<string>();
  for (const specification of specifications) {
    for (const failure of specification.failures) {
      entities.add(`${failure.modelId}:${failure.expressId}`);
    }
  }

  const applicable = specifications.reduce(
    (total, specification) => total + specification.applicableCount,
    0,
  );
  const passed = specifications.reduce(
    (total, specification) => total + specification.passedCount,
    0,
  );

  return {
    totalSpecifications: specifications.length,
    passed: specifications.filter((s) => s.status === "pass").length,
    failed: specifications.filter((s) => s.status === "fail").length,
    notApplicable: specifications.filter((s) => s.status === "not_applicable").length,
    failingEntities: entities.size,
    totalChecks: applicable,
    passRate: applicable === 0 ? 100 : (passed / applicable) * 100,
  };
}

// ---------------------------------------------------------------------------
// Breakdowns for the charts
// ---------------------------------------------------------------------------

export type Breakdown = {
  label: string;
  passed: number;
  failed: number;
  /** Key for click-through, when the row maps to something selectable. */
  key?: string;
};

export function bySpecification(run: ValidationRun): Breakdown[] {
  return run.specifications
    .filter((specification) => specification.status !== "not_applicable")
    .map((specification) => ({
      label: specification.name,
      key: String(specification.index),
      passed: specification.passedCount,
      failed: specification.failedCount,
    }));
}

/**
 * Failures grouped by IFC class.
 *
 * Only failures: the engine does not return passing entities by default (see
 * `IdsValidationOptions.includePassingEntities`), so a passed count per class
 * would be silently zero and read as "nothing passed".
 */
export function byClass(run: ValidationRun, limit = 12): Breakdown[] {
  const counts = new Map<string, number>();

  for (const specification of run.specifications) {
    for (const failure of specification.failures) {
      counts.set(failure.type, (counts.get(failure.type) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, failed]) => ({ label, key: label, passed: 0, failed }));
}

export function byModel(run: ValidationRun): Breakdown[] {
  const passed = new Map<string, number>();
  const failed = new Map<string, number>();

  for (const specification of run.specifications) {
    for (const model of specification.perModel) {
      passed.set(model.modelName, (passed.get(model.modelName) ?? 0) + model.passedCount);
      failed.set(model.modelName, (failed.get(model.modelName) ?? 0) + model.failedCount);
    }
  }

  return run.models.map((model) => ({
    label: model.name,
    key: model.modelId,
    passed: passed.get(model.name) ?? 0,
    failed: failed.get(model.name) ?? 0,
  }));
}

/** Every failure across every specification, for the BCF export. */
export function allFailures(run: ValidationRun): Failure[] {
  return run.specifications.flatMap((specification) => specification.failures);
}

/** A namespaced next-intl translator for "idsFailureDescription" — optional, so callers with no i18n context (tests, the BCF export) keep the English default. */
export type FailureTranslator = (
  key: "expected" | "found" | "failedUnspecified",
  values?: Record<string, string | number>,
) => string;

/**
 * The engine quotes names it has already quoted (`Property ""FireRating"" not
 * found`); one pair is what was meant.
 */
function tidy(text: string): string {
  // Then `"Pset_WallCommon"."FireRating"` is one name, so it is quoted as one.
  return text.replace(/""/g, '"').replace(/"\."/g, ".");
}

/** Why one requirement failed, in a line. */
export function describeRequirement(
  requirement: IdsRequirementResultView,
  t?: FailureTranslator,
): string {
  if (requirement.failureReason) return tidy(requirement.failureReason);
  const parts = [
    requirement.field,
    requirement.expected && (t ? t("expected", { value: requirement.expected }) : `expected ${requirement.expected}`),
    requirement.actual && (t ? t("found", { value: requirement.actual }) : `found ${requirement.actual}`),
  ]
    .filter(Boolean)
    .join(", ");
  // `||`, not `??`: an empty join is a string, and used to leave a blank reason
  // where the requirement's own description would have said something.
  return tidy(
    parts || requirement.description || (t ? t("failedUnspecified") : "Failed an unspecified requirement."),
  );
}

/**
 * Every failed requirement of an element, one line each.
 *
 * Not just the first: an element missing three properties has three things to
 * fix, and listing one made the other two look satisfied.
 */
export function describeRequirements(failure: Failure, t?: FailureTranslator): string[] {
  if (failure.requirements.length === 0) {
    return [t ? t("failedUnspecified") : "Failed an unspecified requirement."];
  }
  return failure.requirements.map((requirement) => describeRequirement(requirement, t));
}

/** All of an element's failed requirements in one line, for a table cell or a BCF list. */
export function describeFailure(failure: Failure, t?: FailureTranslator): string {
  return describeRequirements(failure, t).join("; ");
}

/**
 * A specification that failed on its count — "at least one column", "no
 * proxies" — has no failing element to list, and was shown as having no
 * failures at all.
 */
export function cardinalityFailure(
  specification: AggregatedSpecification,
): { message: string; modelName: string } | null {
  const cardinality = specification.cardinality;
  return cardinality && !cardinality.passed
    ? { message: cardinality.message, modelName: cardinality.modelName }
    : null;
}

/** How many failed requirements a set of failures holds — the issues to fix. */
export function issueCount(failures: Failure[]): number {
  return failures.reduce((total, failure) => total + Math.max(1, failure.requirements.length), 0);
}
