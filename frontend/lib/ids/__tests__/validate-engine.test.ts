// @vitest-environment jsdom

/**
 * The real thing: a real IFC, a real IDS, through the real engine.
 *
 * `report.test.ts` covers the aggregation arithmetic on synthetic input. This
 * covers the part that arithmetic cannot — that `validateIds` on the adapter
 * actually parses the specification, walks the model, and comes back with the
 * failure we know is in the fixture.
 *
 * `fixtures/ifc/georeferenced-wall-ifc4.ifc` is built for this: Wall A carries
 * `Pset_WallCommon.FireRating`, Wall B does not.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "@/lib/ifc/ifc-lite-adapter";
import { IdsDocumentParseError, parseIdsForEngine } from "@/lib/ifc/ids-document";
import { aggregate } from "../report";
import { renderHtmlReport } from "../html-report";
import { validateAgainstSchema } from "../validate";
import { parseIds } from "../parse";

const IFC = path.resolve(__dirname, "../../../fixtures/ifc");
const IDS = path.resolve(__dirname, "../../../fixtures/ids");

async function loadModel(name: string) {
  const buffer = await readFile(path.join(IFC, name));
  return ifcLiteAdapter.loadModel({
    name,
    bytes: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  });
}

/**
 * Parse on the way in, mirroring `ifc-client.ts`.
 *
 * The adapter takes a parsed document because the worker it normally runs in
 * has no `DOMParser`; these tests call it directly, so they do the same step.
 */
const ids = async (name: string) =>
  parseIdsForEngine(await readFile(path.join(IDS, name), "utf8"));

const model = await loadModel("georeferenced-wall-ifc4.ifc");

afterAll(() => {
  resetIfcLiteAdapter();
});

describe("fixtures", () => {
  it("are schema-valid IDS 1.0", async () => {
    // A malformed fixture would make every test below meaningless.
    for (const name of ["wall-fire-rating.ids", "all-pass.ids", "not-applicable.ids"]) {
      const { document } = parseIds(await readFile(path.join(IDS, name), "utf8"));
      const result = await validateAgainstSchema(document);
      expect(result.errors, `${name}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });
});

describe("validateIds", () => {
  it("finds the wall that has no fire rating", async () => {
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("wall-fire-rating.ids"),
    );

    expect(report.specifications).toHaveLength(1);
    const [specification] = report.specifications;

    // Two walls apply; Wall B is missing the property.
    expect(specification.applicableCount).toBe(2);
    expect(specification.passedCount).toBe(1);
    expect(specification.failedCount).toBe(1);
    expect(specification.status).toBe("fail");
  });

  it("reports which element failed, and why, in prose", async () => {
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("wall-fire-rating.ids"),
    );

    const failing = report.specifications[0].entities.filter((e) => !e.passed);
    expect(failing).toHaveLength(1);

    const [entity] = failing;
    expect(entity.type.toUpperCase()).toContain("WALL");
    expect(entity.name).toBe("Wall B");
    // The GlobalId is what a BCF viewpoint needs; without it the export cannot
    // reference the element at all.
    expect(entity.globalId).toBe("8YvctVUKr0kugbFTf53O9L");

    const reason = entity.requirements.find((r) => r.status === "fail");
    expect(reason).toBeDefined();
    expect(reason!.description.length).toBeGreaterThan(0);
  });

  it("passes a specification the model satisfies", async () => {
    const report = await ifcLiteAdapter.validateIds(model.id, await ids("all-pass.ids"));

    expect(report.specifications[0].status).toBe("pass");
    expect(report.specifications[0].failedCount).toBe(0);
  });

  it("reports a specification that matched nothing as applying to nothing", async () => {
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("not-applicable.ids"),
    );

    expect(report.specifications[0].applicableCount).toBe(0);
    expect(report.specifications[0].failedCount).toBe(0);
  });

  it("does not present a specification that matched nothing as a pass", async () => {
    // The engine returns `status: "pass"` here — vacuously true, and read by a
    // coordinator as "the model satisfies this requirement" when in fact the
    // requirement was never tested. `aggregate()` recomputes status from
    // applicableCount for exactly this reason; this test is what pins that
    // behaviour down, and it is why the status is not taken from the engine.
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("not-applicable.ids"),
    );
    expect(report.specifications[0].status).toBe("pass");

    const run = aggregate([report], [{ modelId: model.id, name: model.name }], {
      idsTitle: "Beams",
      startedAt: "2026-09-04T09:00:00.000Z",
      finishedAt: "2026-09-04T09:00:01.000Z",
    });

    expect(run.specifications[0].status).toBe("not_applicable");
    expect(run.summary.passed).toBe(0);
    expect(run.summary.notApplicable).toBe(1);
  });

  it("omits passing entities by default", async () => {
    // Holding them is what makes a large validation run out of memory.
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("wall-fire-rating.ids"),
    );

    expect(report.specifications[0].entities.every((e) => !e.passed)).toBe(true);
  });

  it("includes them when asked", async () => {
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("wall-fire-rating.ids"),
      { includePassingEntities: true },
    );

    expect(report.specifications[0].entities.some((e) => e.passed)).toBe(true);
  });

  it("reports progress while it runs", async () => {
    const seen: number[] = [];
    await ifcLiteAdapter.validateIds(model.id, await ids("wall-fire-rating.ids"), {
      onProgress: (progress) => seen.push(progress.percent),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(100);
  });

  it("carries the validated model's identity, schema and entity count through", async () => {
    const report = await ifcLiteAdapter.validateIds(model.id, await ids("all-pass.ids"));
    expect(report.modelId).toBe(model.id);
    expect(report.schemaVersion).toBe(model.schemaToken ?? model.schema);
    expect(report.entityCount).toBe(model.entityCount);
  });

  it("rejects an IDS that is not well-formed at the parse step", () => {
    // Parsing is now a separate, synchronous step on the main thread, so a
    // malformed file fails there rather than inside the worker — which is a
    // better place for it: the error names the file, not the model.
    expect(() => parseIdsForEngine("<ids>truncated")).toThrow(
      IdsDocumentParseError,
    );
  });
});

describe("end to end", () => {
  it("aggregates a real report and renders it as HTML", async () => {
    const report = await ifcLiteAdapter.validateIds(
      model.id,
      await ids("wall-fire-rating.ids"),
    );

    const run = aggregate([report], [{ modelId: model.id, name: model.name }], {
      idsTitle: "Wall fire rating",
      startedAt: "2026-09-04T09:00:00.000Z",
      finishedAt: "2026-09-04T09:00:05.000Z",
    });

    expect(run.summary.failed).toBe(1);
    expect(run.summary.failingEntities).toBe(1);

    const html = renderHtmlReport(run);
    expect(html).toContain("Wall fire rating");
    expect(html).toContain("Wall B");
    expect(html).toContain("1 specification not satisfied");

    // Self-contained: nothing to fetch when it is opened months later.
    expect(html).not.toMatch(/<(link|script)\b/);
    expect(html).not.toMatch(/\bsrc=/);
  });
});
