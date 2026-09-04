import { describe, expect, it } from "vitest";

import {
  aggregate,
  allFailures,
  byClass,
  byModel,
  bySpecification,
  describeFailure,
} from "../report";
import type {
  IdsEntityResultView,
  IdsModelReport,
  IdsSpecificationResultView,
} from "@/lib/ifc/types";

const META = {
  idsTitle: "Structural handover",
  startedAt: "2026-09-04T09:00:00.000Z",
  finishedAt: "2026-09-04T09:00:30.000Z",
};

function entity(
  expressId: number,
  passed: boolean,
  patch: Partial<IdsEntityResultView> = {},
): IdsEntityResultView {
  return {
    expressId,
    type: "IfcWall",
    name: `Wall ${expressId}`,
    globalId: `guid-${expressId}`,
    passed,
    requirements: passed
      ? [{ status: "pass", facetType: "property", description: "has FireRating" }]
      : [
          {
            status: "fail",
            facetType: "property",
            description: "has FireRating",
            failureReason: "expected Pset_WallCommon.FireRating, found none",
            field: "Pset_WallCommon.FireRating",
            expected: "any value",
          },
        ],
    ...patch,
  };
}

function specification(
  index: number,
  patch: Partial<IdsSpecificationResultView> = {},
): IdsSpecificationResultView {
  const entities = patch.entities ?? [];
  const failed = entities.filter((e) => !e.passed).length;
  const passed = entities.length - failed;

  return {
    index,
    name: `Specification ${index}`,
    status: entities.length === 0 ? "not_applicable" : failed > 0 ? "fail" : "pass",
    applicableCount: entities.length,
    passedCount: passed,
    failedCount: failed,
    passRate: entities.length === 0 ? 100 : (passed / entities.length) * 100,
    entities,
    ...patch,
  };
}

function report(modelId: string, specifications: IdsSpecificationResultView[]): IdsModelReport {
  return { modelId, schemaVersion: "IFC4", entityCount: 100, specifications };
}

const MODELS = [
  { modelId: "m1", name: "architecture.ifc" },
  { modelId: "m2", name: "structure.ifc" },
];

describe("aggregate", () => {
  it("merges the same specification across models", () => {
    const run = aggregate(
      [
        report("m1", [specification(0, { entities: [entity(1, true), entity(2, false)] })]),
        report("m2", [specification(0, { entities: [entity(3, true)] })]),
      ],
      MODELS,
      META,
    );

    expect(run.specifications).toHaveLength(1);
    const [merged] = run.specifications;
    expect(merged.applicableCount).toBe(3);
    expect(merged.passedCount).toBe(2);
    expect(merged.failedCount).toBe(1);
    expect(merged.status).toBe("fail");
    expect(merged.perModel).toHaveLength(2);
  });

  it("joins specifications on index, not name", () => {
    // Two specifications may legitimately share a name; the index is the
    // document's own identity for them.
    const run = aggregate(
      [
        report("m1", [
          specification(0, { name: "Walls", entities: [entity(1, true)] }),
          specification(1, { name: "Walls", entities: [entity(2, false)] }),
        ]),
      ],
      MODELS,
      META,
    );

    expect(run.specifications).toHaveLength(2);
    expect(run.specifications[0].status).toBe("pass");
    expect(run.specifications[1].status).toBe("fail");
  });

  it("is not_applicable only when no model had an applicable entity", () => {
    const run = aggregate(
      [report("m1", [specification(0)]), report("m2", [specification(0)])],
      MODELS,
      META,
    );

    expect(run.specifications[0].status).toBe("not_applicable");
  });

  it("does not let a model with nothing applicable turn a failure green", () => {
    // The failure mode this guards: the discipline that owns the requirement is
    // loaded and fails, another model matches nothing, and averaging says pass.
    const run = aggregate(
      [
        report("m1", [specification(0, { entities: [entity(1, false)] })]),
        report("m2", [specification(0)]),
      ],
      MODELS,
      META,
    );

    expect(run.specifications[0].status).toBe("fail");
  });

  it("fails a specification whose cardinality was not met", () => {
    const run = aggregate(
      [
        report("m1", [
          specification(0, {
            entities: [],
            cardinality: {
              passed: false,
              actualCount: 0,
              message: "Expected at least 1 IfcWall, found 0",
            },
          }),
        ]),
      ],
      MODELS,
      META,
    );

    // No applicable entities, but the count itself was the requirement.
    expect(run.specifications[0].status).toBe("fail");
    expect(run.specifications[0].cardinality?.passed).toBe(false);
  });

  it("keeps a failing cardinality over a passing one from another model", () => {
    const run = aggregate(
      [
        report("m1", [
          specification(0, {
            cardinality: { passed: true, actualCount: 4, message: "ok" },
          }),
        ]),
        report("m2", [
          specification(0, {
            cardinality: { passed: false, actualCount: 0, message: "none found" },
          }),
        ]),
      ],
      MODELS,
      META,
    );

    expect(run.specifications[0].cardinality?.passed).toBe(false);
    expect(run.specifications[0].cardinality?.modelName).toBe("structure.ifc");
  });

  it("carries the model name onto each failure", () => {
    const run = aggregate(
      [report("m2", [specification(0, { entities: [entity(7, false)] })])],
      MODELS,
      META,
    );

    expect(run.specifications[0].failures[0].modelName).toBe("structure.ifc");
    expect(run.specifications[0].failures[0].globalId).toBe("guid-7");
  });

  it("keeps only the failing requirements on a failure", () => {
    const mixed = entity(1, false, {
      requirements: [
        { status: "pass", facetType: "entity", description: "is IfcWall" },
        {
          status: "fail",
          facetType: "property",
          description: "has FireRating",
          failureReason: "not found",
        },
      ],
    });

    const run = aggregate(
      [report("m1", [specification(0, { entities: [mixed] })])],
      MODELS,
      META,
    );

    expect(run.specifications[0].failures[0].requirements).toHaveLength(1);
    expect(run.specifications[0].failures[0].requirements[0].status).toBe("fail");
  });

  it("gives every failure an id that is stable and unique", () => {
    const run = aggregate(
      [
        report("m1", [
          specification(0, { entities: [entity(1, false)] }),
          specification(1, { entities: [entity(1, false)] }),
        ]),
      ],
      MODELS,
      META,
    );

    const ids = allFailures(run).map((failure) => failure.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("counts one element failing several specifications once", () => {
    // It is one thing to go and fix; reporting it as two overstates the work.
    const run = aggregate(
      [
        report("m1", [
          specification(0, { entities: [entity(1, false)] }),
          specification(1, { entities: [entity(1, false)] }),
        ]),
      ],
      MODELS,
      META,
    );

    expect(run.summary.failingEntities).toBe(1);
    expect(run.summary.failed).toBe(2);
  });

  it("summarises an entirely passing run", () => {
    const run = aggregate(
      [report("m1", [specification(0, { entities: [entity(1, true)] })])],
      MODELS,
      META,
    );

    expect(run.summary).toMatchObject({
      passed: 1,
      failed: 0,
      notApplicable: 0,
      failingEntities: 0,
      passRate: 100,
    });
  });

  it("reports a pass rate of 100 when nothing was applicable", () => {
    // 0/0 is NaN, which renders as "NaN%".
    const run = aggregate([report("m1", [specification(0)])], MODELS, META);

    expect(run.summary.passRate).toBe(100);
    expect(run.specifications[0].passRate).toBe(100);
  });

  it("handles no reports at all", () => {
    const run = aggregate([], MODELS, META);
    expect(run.specifications).toEqual([]);
    expect(run.summary.totalSpecifications).toBe(0);
  });
});

describe("breakdowns", () => {
  const run = aggregate(
    [
      report("m1", [
        specification(0, { name: "Fire", entities: [entity(1, false), entity(2, true)] }),
        specification(1, { name: "Empty" }),
      ]),
      report("m2", [
        specification(0, {
          name: "Fire",
          entities: [entity(3, false, { type: "IfcSlab" })],
        }),
        specification(1, { name: "Empty" }),
      ]),
    ],
    MODELS,
    META,
  );

  it("omits not-applicable specifications from the specification chart", () => {
    // A bar of height zero labelled "Empty" invites the reading "everything
    // failed" rather than "this did not apply".
    const bars = bySpecification(run);
    expect(bars.map((bar) => bar.label)).toEqual(["Fire"]);
  });

  it("counts failures by IFC class, most common first", () => {
    const bars = byClass(run);
    expect(bars[0]).toMatchObject({ label: "IfcWall", failed: 1 });
    expect(bars.map((bar) => bar.label)).toContain("IfcSlab");
  });

  it("reports every model, including one with no failures", () => {
    const bars = byModel(run);
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.label)).toEqual(["architecture.ifc", "structure.ifc"]);
  });
});

describe("describeFailure", () => {
  it("prefers the engine's own reason", () => {
    const run = aggregate(
      [report("m1", [specification(0, { entities: [entity(1, false)] })])],
      MODELS,
      META,
    );

    expect(describeFailure(run.specifications[0].failures[0])).toBe(
      "expected Pset_WallCommon.FireRating, found none",
    );
  });

  it("builds a reason from the fields when there is none", () => {
    const bare = entity(1, false, {
      requirements: [
        {
          status: "fail",
          facetType: "attribute",
          description: "Name is set",
          field: "Name",
          expected: "any value",
          actual: "(empty)",
        },
      ],
    });

    const run = aggregate(
      [report("m1", [specification(0, { entities: [bare] })])],
      MODELS,
      META,
    );

    expect(describeFailure(run.specifications[0].failures[0])).toBe(
      "Name, expected any value, found (empty)",
    );
  });
});
