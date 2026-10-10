// @vitest-environment jsdom

/**
 * IDS failures → BCF.
 *
 * The claim worth testing is that the issue set is **schema-valid BCF 3.0**,
 * not merely that it has the right number of topics — the export exists so that
 * Solibri and BIMcollab can open it, and a file they reject is worthless
 * however well-structured it looks in a debugger.
 *
 * Snapshot capture is not exercised here: it drives a real WebGL renderer,
 * which is `e2e/ids-validate.spec.ts`'s job.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "@/lib/ifc/ifc-lite-adapter";
import { parseIdsForEngine } from "@/lib/ifc/ids-document";
import { serializeBcf } from "@/lib/bcf/serialize";
import { validateArchive } from "@/lib/bcf/validate";
import { parseBcf } from "@/lib/bcf/parse";
import { reportToBcf } from "../bcf-export";
import { aggregate, type ValidationRun } from "../report";

const IFC = path.resolve(__dirname, "../../../fixtures/ifc");
const IDS = path.resolve(__dirname, "../../../fixtures/ids");

const buffer = await readFile(path.join(IFC, "georeferenced-wall-ifc4.ifc"));
const model = await ifcLiteAdapter.loadModel({
  name: "georeferenced-wall-ifc4.ifc",
  bytes: buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer,
});

const report = await ifcLiteAdapter.validateIds(
  model.id,
  parseIdsForEngine(await readFile(path.join(IDS, "wall-fire-rating.ids"), "utf8")),
);

const run: ValidationRun = aggregate(
  [report],
  [{ modelId: model.id, name: model.name }],
  {
    idsTitle: "Wall fire rating",
    startedAt: "2026-09-04T09:00:00.000Z",
    finishedAt: "2026-09-04T09:00:05.000Z",
  },
);

afterAll(() => {
  resetIfcLiteAdapter();
});

describe("reportToBcf", () => {
  it("writes one topic per failing element by default", async () => {
    const file = await reportToBcf(run, { author: "engenheiro@example.pt" });

    expect(file.topics).toHaveLength(run.summary.failingEntities);
    expect(file.topics[0].title).toContain("Wall B");
    expect(file.topics[0].title).toContain("Walls carry a fire rating");
  });

  it("writes one topic per specification when grouped", async () => {
    const file = await reportToBcf(run, { grouping: "per-specification" });

    expect(file.topics).toHaveLength(1);
    expect(file.topics[0].title).toContain("1 failing element");
  });

  it("puts the reason in the description", async () => {
    const file = await reportToBcf(run);
    const description = file.topics[0].description ?? "";

    expect(description).toContain("8YvctVUKr0kugbFTf53O9L");
    expect(description.toLowerCase()).toMatch(/firerating|fire rating/);
  });

  it("labels topics so they can be filtered back out", async () => {
    const file = await reportToBcf(run);

    expect(file.topics[0].labels).toContain("IDS");
    expect(file.topics[0].labels).toContain("Walls carry a fire rating");
  });

  it("records which IFC the failure came from", async () => {
    // Needed by lib/bcf/actions.ts to pick the reference frame when the
    // viewpoint is later reopened.
    const file = await reportToBcf(run);

    expect(file.topics[0].headerFiles[0].filename).toBe(
      "georeferenced-wall-ifc4.ifc",
    );
  });

  it("attributes the topic and explains where it came from", async () => {
    const file = await reportToBcf(run, { author: "engenheiro@example.pt" });

    expect(file.topics[0].creationAuthor).toBe("engenheiro@example.pt");
    expect(file.topics[0].comments[0].comment).toContain("Wall fire rating");
  });

  it("produces a schema-valid BCF 3.0 archive", async () => {
    const file = await reportToBcf(run, { author: "engenheiro@example.pt" });
    const { bytes } = serializeBcf(file);

    expect(await validateArchive(bytes)).toEqual([]);
  });

  it("survives a round trip through the reader", async () => {
    const file = await reportToBcf(run);
    const { bytes } = serializeBcf(file);
    const again = parseBcf(bytes, "report.bcf").file;

    expect(again.topics).toHaveLength(file.topics.length);
    expect(again.topics[0].title).toBe(file.topics[0].title);
    expect(again.topics[0].labels).toEqual(file.topics[0].labels);
  });

  it("writes a valid archive even with nothing to report", async () => {
    const empty = aggregate([], [], {
      idsTitle: "Nothing",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
    const file = await reportToBcf(empty);

    expect(file.topics).toEqual([]);
    expect(await validateArchive(serializeBcf(file).bytes)).toEqual([]);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const file = await reportToBcf(run, { signal: controller.signal });
    expect(file.topics).toEqual([]);
  });
});
