/**
 * The exported report's layout (ifclite.com's: summary rates, collapsible
 * specification cards, requirement blocks with their failing elements), built
 * from a hand-made run so each case is visible in the test.
 */

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import pt from "@/messages/pt.json";

import { passRate, renderHtmlReport, type ReportTranslator } from "../html-report";
import type { AggregatedSpecification, Failure, ValidationRun } from "../report";

function failure(expressId: number, name: string | undefined, reason: string, requirementId = "r1"): Failure {
  return {
    id: `m1:${expressId}:0`,
    modelId: "m1",
    modelName: "walls.ifc",
    expressId,
    globalId: `GUID${expressId}`,
    type: "IfcWall",
    name,
    specificationIndex: 0,
    specificationName: "Walls",
    requirements: [{ requirementId, status: "fail", facetType: "property", description: "", failureReason: reason }],
  };
}

const wallB = failure(12, "Wall B", "FireRating not found");

const walls: AggregatedSpecification = {
  index: 0,
  name: "Walls",
  description: "Walls carry a fire rating",
  status: "fail",
  applicableCount: 3,
  passedCount: 2,
  failedCount: 1,
  passRate: (2 / 3) * 100,
  failures: [wallB],
  requirements: [
    { id: "r1", label: "FireRating is provided", optionality: "required", passedCount: 2, failedCount: 1, failures: [wallB] },
    { id: "r2", label: "Name is provided", optionality: "optional", instructions: "Use the type mark", passedCount: 3, failedCount: 0, failures: [] },
  ],
  perModel: [],
  errors: [],
};

const slabs: AggregatedSpecification = {
  ...walls,
  index: 1,
  name: "Slabs",
  description: undefined,
  status: "pass",
  applicableCount: 1,
  passedCount: 1,
  failedCount: 0,
  passRate: 100,
  failures: [],
  requirements: [{ id: "s1", label: "LoadBearing is provided", optionality: "required", passedCount: 1, failedCount: 0, failures: [] }],
};

const columns: AggregatedSpecification = {
  ...slabs,
  index: 2,
  name: "Columns",
  status: "fail",
  applicableCount: 0,
  passedCount: 0,
  passRate: 100,
  requirements: [],
  cardinality: { passed: false, message: "Expected at least 1, found 0", modelName: "walls.ifc" },
};

const proxies: AggregatedSpecification = {
  ...slabs,
  index: 3,
  name: "Proxies",
  status: "not_applicable",
  applicableCount: 0,
  passedCount: 0,
  requirements: [],
};

function run(models = 1, specifications = [walls, slabs, columns, proxies]): ValidationRun {
  return {
    idsTitle: "Handover",
    startedAt: "2026-11-20T09:00:00.000Z",
    finishedAt: "2026-11-20T09:00:05.000Z",
    models: Array.from({ length: models }, (_, index) => ({
      modelId: `m${index + 1}`,
      name: index === 0 ? "walls.ifc" : `other-${index}.ifc`,
      schemaVersion: "IFC4",
      entityCount: 1234,
    })),
    specifications,
    summary: {
      totalSpecifications: specifications.length,
      passed: specifications.filter((s) => s.status === "pass").length,
      failed: specifications.filter((s) => s.status === "fail").length,
      notApplicable: specifications.filter((s) => s.status === "not_applicable").length,
      failingEntities: 1,
      totalChecks: 4,
      passRate: 75,
    },
  };
}

/** The text of the element `selector`-ish fragment starting at `marker`, tags stripped. */
function textAfter(html: string, marker: string, length = 400): string {
  const at = html.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  return html.slice(at, at + length).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("passRate", () => {
  it("floors, so a failing element never reads as 100%", () => {
    expect(passRate(9999, 10000)).toBe(99.9);
    expect(passRate(2, 3)).toBe(66.6);
    expect(passRate(3, 3)).toBe(100);
  });

  it("is null when nothing was counted, not 100", () => {
    expect(passRate(0, 0)).toBeNull();
  });
});

describe("renderHtmlReport", () => {
  const html = renderHtmlReport(run());

  it("summarises specifications and elements in tiles", () => {
    expect(html).toContain("2 specifications not satisfied");
    expect(textAfter(html, 'class="stats"', 1200)).toContain("4 Specifications 1 Specifications passed 2 Specifications failed 1 Not applicable 4 Elements checked 1 Failing elements");
  });

  it("gives the three rates, each with what it counts", () => {
    // Checks: walls 2+3 of 6 (r1: 2/3, r2: 3/3), slabs 1/1 → 6 of 7.
    expect(textAfter(html, 'class="rates"', 900)).toContain("85.7% Check pass rate");
    expect(html).toContain("6 of 7 element–requirement checks passed");
    expect(html).toContain("3 of 4 applicable elements passed every requirement");
    // Not-applicable specifications are not counted either way.
    expect(html).toContain("1 of 3 applicable specifications passed");
  });

  it("opens failed specifications and collapses the rest", () => {
    expect(html).toMatch(/<details class="spec fail" open>\s*<summary[^>]*>[\s\S]*?Walls/);
    expect(html).toMatch(/<details class="spec pass">\s*<summary[^>]*>[\s\S]*?Slabs/);
    expect(html).toMatch(/<details class="spec not_applicable">/);
  });

  it("filters specifications by status without a script", () => {
    for (const status of ["all", "fail", "pass", "not_applicable"]) {
      expect(html).toContain(`id="show-${status}"`);
    }
    expect(html).toContain("body:has(#show-fail:checked) .spec:not(.fail)");
  });

  it("breaks a specification down by requirement, with checks and failing elements", () => {
    const fireRating = textAfter(html, '<div class="req fail">', 1200);
    expect(fireRating).toContain("FireRating is provided");
    expect(fireRating).toContain("2 of 3 checks passed (66.6%)");
    expect(fireRating).toContain("IfcWall Wall B GUID12 12 FireRating not found");

    const name = textAfter(html, '<div class="req pass">');
    expect(name).toContain("Name is provided optional Use the type mark 3 of 3 checks passed (100%)");
  });

  it("lists every failing element with all its reasons, collapsed", () => {
    expect(textAfter(html, '<details class="by-element">', 1000)).toContain("By element 1");
  });

  it("explains a specification that failed on its count, and one that matched nothing", () => {
    expect(textAfter(html, "Columns", 1200)).toContain("The specification’s count is not met Expected at least 1, found 0 (walls.ifc)");
    expect(textAfter(html, "Proxies", 1200)).toContain("No element matched this specification.");
  });

  it("names the model of each element only for a federation", () => {
    expect(html).not.toMatch(/<td>walls\.ifc<\/td>\s*<td class="reason">/);
    expect(renderHtmlReport(run(2))).toMatch(/<td>walls\.ifc<\/td>\s*<td class="reason">/);
  });

  it("caps a requirement's elements and says how many are hidden", () => {
    const many = Array.from({ length: 130 }, (_, index) => failure(index + 1, `Wall ${index + 1}`, "missing"));
    const big: AggregatedSpecification = {
      ...walls,
      applicableCount: 130,
      passedCount: 0,
      failedCount: 130,
      failures: many,
      requirements: [{ ...walls.requirements[0], passedCount: 0, failedCount: 130, failures: many }],
    };
    const capped = renderHtmlReport(run(1, [big]));
    expect(capped).toContain("…and 30 more. Export BCF for the complete set.");
  });

  it("stays self-contained", () => {
    expect(html).not.toMatch(/<(link|script)\b/);
    expect(html).not.toMatch(/\bsrc=|\bhref=/);
  });

  it("escapes what the model and the IDS supply", () => {
    const hostile = renderHtmlReport(
      run(1, [{ ...walls, name: '<img src=x onerror="alert(1)">', failures: [failure(1, "<b>x</b>", "a < b")] }]),
    );
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("in the interface's language", () => {
  const translator = (messages: typeof en, locale: string): ReportTranslator => {
    const t = createTranslator({ locale, messages, namespace: "idsReport" });
    return (key, values) => (t as (key: string, values?: Record<string, string | number>) => string)(key, values);
  };

  it("renders every label from the Portuguese catalogue", () => {
    const html = renderHtmlReport(run(), translator(pt as typeof en, "pt"), undefined, "pt");
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain("2 especificações não satisfeitas");
    expect(html).toContain("85,7%");
    expect(html).toContain("1 reprovado");
    expect(html).toContain("2 aprovados");
    expect(html).toContain("O número de elementos exigido pela especificação não é cumprido");
    // A key missing from the catalogue comes back as its path.
    expect(html).not.toMatch(/idsReport\./);
  });

  it("matches the built-in English with the English catalogue", () => {
    expect(renderHtmlReport(run(), translator(en, "en"))).toBe(renderHtmlReport(run()));
  });
});
