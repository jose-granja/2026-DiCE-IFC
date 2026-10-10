import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";
import { EMPTY_ELEMENT_FILTER, type QuantityQuery } from "../types";

let modelId = "";

beforeAll(async () => {
  const buffer = await readFile(path.resolve(__dirname, "../../../fixtures/ifc/clash-ifc4.ifc"));
  const summary = await ifcLiteAdapter.loadModel({
    name: "clash.ifc",
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  });
  modelId = summary.id;
});

afterAll(() => resetIfcLiteAdapter());

const query = (materialCategories: string[] | undefined, over: Partial<QuantityQuery["filters"]> = {}): QuantityQuery => ({
  filters: {
    classes: [],
    predefinedTypes: [],
    objectTypes: [],
    materials: [],
    materialCategories,
    properties: [],
    ...over,
  },
  sources: [{ id: "count", alias: "count", kind: "count" }],
});

const names = async (q: QuantityQuery) =>
  (await ifcLiteAdapter.evaluateQuantityQuery(modelId, q)).rows.map((row) => row.name).sort();

describe("material category in a quantity query", () => {
  it("selects by IfcMaterial.Category", async () => {
    expect(await names(query(["Metal"]))).toEqual(["Duct crossing the wall", "Pipe near the wall"]);
    expect(await names(query(["Concrete"]))).toEqual(["Wall A"]);
    expect(await names(query(["Timber"]))).toEqual([]);
  });

  it("takes wildcards and regular expressions, with alternatives", async () => {
    expect(await names(query(["Met*"]))).toHaveLength(2);
    expect(await names(query(["/^conc/"]))).toEqual(["Wall A"]);
    expect(await names(query(["Concrete", "Metal"]))).toHaveLength(3);
  });

  it("combines with the other filters", async () => {
    expect(await names(query(["Metal"], { classes: ["IfcPipeSegment"] }))).toEqual(["Pipe near the wall"]);
    expect(await names(query(["Metal"], { materials: ["Concrete*"] }))).toEqual([]);
  });

  it("leaves a query saved before the field existed unchanged", async () => {
    expect(await names(query(undefined, { classes: ["IfcWall"] }))).toEqual(["Wall A"]);
    expect(await names(query([], { classes: ["IfcSlab"] }))).toEqual(["Slab far away"]);
  });

  it("is the same selection a clash group makes", async () => {
    const matches = await ifcLiteAdapter.selectElements(modelId, { ...EMPTY_ELEMENT_FILTER, materialCategories: ["Metal"] });
    expect(matches.map((m) => m.name).sort()).toEqual(["Duct crossing the wall", "Pipe near the wall"]);
  });
});
