import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter } from "../ifc-lite-adapter";
import { EMPTY_ELEMENT_FILTER, type ModelSummary } from "../types";

/**
 * What a filter, a quantity, a lens or a clash group may pick. IFC 4.3 places an
 * alignment by aggregation under the project and a reference in the site — not
 * by containment — and counting containment alone made it unselectable.
 */

const FIXTURE = path.resolve(__dirname, "../../../fixtures/ifc/alignment-referenced-ifc4x3.ifc");
const ALIGNMENT = 72;
const GIRDER = 48;

let model: ModelSummary;
beforeAll(async () => {
  const buffer = await readFile(FIXTURE);
  model = await ifcLiteAdapter.loadModel({
    name: "alignment-referenced-ifc4x3.ifc",
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
});
afterAll(() => ifcLiteAdapter.unloadModel(model.id));

const only = (classes: string[]) => ({ ...EMPTY_ELEMENT_FILTER, classes });

describe("an alignment the model places by aggregation and reference", () => {
  it("is selected by its class, as a clash group or lens rule picks it", async () => {
    const matches = await ifcLiteAdapter.selectElements(model.id, only(["IfcAlignment"]));
    expect(matches.map((match) => match.expressId)).toEqual([ALIGNMENT]);
  });

  it("is a class in the filter panel", async () => {
    const facets = await ifcLiteAdapter.getFilterFacets(model.id);
    expect(JSON.stringify(facets)).toContain("IfcAlignment");
  });

  it("is counted by a quantity", async () => {
    const result = await ifcLiteAdapter.evaluateQuantityQuery(model.id, {
      filters: { classes: ["IfcAlignment"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
      sources: [{ id: "n", alias: "count", kind: "count" }],
    });
    expect(result.matchedCount).toBe(1);
  });

  it("gets its own colour from an auto-colour lens by class", async () => {
    const groups = await ifcLiteAdapter.groupElementsByValue(model.id, { kind: "class" });
    expect(JSON.stringify(groups)).toContain("IfcAlignment");
  });
});

describe("a part of an assembly", () => {
  it("is placed through its whole, at any depth", async () => {
    const column = await ifcLiteAdapter.selectElements(model.id, only(["IfcColumn"]));
    expect(column.map((match) => match.expressId)).toEqual([81]);
    const footing = await ifcLiteAdapter.selectElements(model.id, only(["IfcFooting"]));
    expect(footing.map((match) => match.expressId)).toEqual([82]);
    // The whole is still one too.
    const assembly = await ifcLiteAdapter.selectElements(model.id, only(["IfcElementAssembly"]));
    expect(assembly.map((match) => match.expressId)).toEqual([80]);
  });
});

// The model this was found on. Kept local — no download and no copy committed.
describe.skipIf(!process.env.ACERNO_IFC)("Viadotto Acerno", () => {
  it("has its columns, footings and piles to pick, and none of their types", async () => {
    const buffer = await readFile(process.env.ACERNO_IFC!);
    const acerno = await ifcLiteAdapter.loadModel({
      name: "acerno.ifc",
      bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });
    try {
      const count = async (classes: string[]) =>
        (await ifcLiteAdapter.selectElements(acerno.id, only(classes))).length;
      expect(await count(["IfcColumn"])).toBe(18);
      expect(await count(["IfcFooting"])).toBe(20);
      expect(await count(["IfcPile"])).toBe(714);
      expect(await count(["IfcMember"])).toBe(550);
      expect(await count(["IfcColumnType", "IfcPileType", "IfcElementAssemblyType"])).toBe(0);
      expect(await count(["IfcBridge", "IfcBridgePart", "IfcSite"])).toBe(0);
    } finally {
      await ifcLiteAdapter.unloadModel(acerno.id);
    }
  }, 300_000);
});

describe("what stays out", () => {
  it("is a type object, so IfcBeam* is the beam and not its type", async () => {
    const matches = await ifcLiteAdapter.selectElements(model.id, only(["IfcBeam*"]));
    expect(matches.map((match) => match.expressId)).toEqual([GIRDER]);
  });

  it("is the spatial structure itself", async () => {
    const matches = await ifcLiteAdapter.selectElements(model.id, only(["IfcSite", "IfcBridge", "IfcProject"]));
    expect(matches).toEqual([]);
  });
});
