import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";
import { EMPTY_ELEMENT_FILTER, type ElementFilter } from "../types";

let modelId = "";

beforeAll(async () => {
  const buffer = await readFile(path.resolve(__dirname, "../../../fixtures/ifc/facets-ifc4.ifc"));
  const summary = await ifcLiteAdapter.loadModel({
    name: "facets.ifc",
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  });
  modelId = summary.id;
});

afterAll(() => resetIfcLiteAdapter());

const select = async (over: Partial<ElementFilter>) =>
  (await ifcLiteAdapter.selectElements(modelId, { ...EMPTY_ELEMENT_FILTER, ...over })).map((m) => m.name);

describe("selectElements", () => {
  it("selects nothing for an empty filter", async () => {
    expect(await select({})).toEqual([]);
  });

  it("selects by class, with a wildcard", async () => {
    expect(await select({ classes: ["IfcWall"] })).toEqual(["Wall A", "Wall B"]);
    expect(await select({ classes: ["IfcWal*"] })).toEqual(["Wall A", "Wall B"]);
    expect(await select({ classes: ["IfcSlab"] })).toEqual(["Slab A"]);
  });

  it("selects by the Name attribute and by object type", async () => {
    expect(await select({ names: ["Wall A"] })).toEqual(["Wall A"]);
    expect(await select({ names: ["Wall *"] })).toEqual(["Wall A", "Wall B"]);
    expect(await select({ objectTypes: ["Basic Wall 200"] })).toEqual(["Wall A", "Wall B"]);
  });

  it("selects by material", async () => {
    const withConcrete = await select({ materials: ["Concrete*"] });
    expect(withConcrete.length).toBeGreaterThan(0);
    expect(await select({ materials: ["No such material"] })).toEqual([]);
  });

  it("selects by a property in a property set", async () => {
    expect(
      await select({
        classes: ["IfcWall"],
        properties: [
          { setName: "Pset_WallCommon", propertyName: "FireRating", operator: "equals", value: "REI 60" },
        ],
      }),
    ).toEqual(["Wall A", "Wall B"]);
    expect(
      await select({
        classes: ["IfcWall"],
        properties: [
          { setName: "Pset_WallCommon", propertyName: "FireRating", operator: "equals", value: "REI 90" },
        ],
      }),
    ).toEqual([]);
  });

  it("reports a bad pattern instead of selecting something", async () => {
    await expect(select({ names: ["/(/"] })).rejects.toThrow(/Invalid regular expression/);
  });

  it("returns the identity a clash needs", async () => {
    const [wall] = await ifcLiteAdapter.selectElements(modelId, { ...EMPTY_ELEMENT_FILTER, names: ["Wall A"] });
    expect(wall).toMatchObject({ type: "IfcWall", globalId: "2FacetWall00000000001", name: "Wall A" });
  });
});

/**
 * Classification selection through the engine. This is the path clash groups
 * take (`lib/clash/run.ts` → `selectElements`), and the fixture puts Wall A in
 * two systems at once so "the same reference" is actually exercised.
 */
describe("selectElements by classification", () => {
  let classified = "";

  beforeAll(async () => {
    const buffer = await readFile(
      path.resolve(__dirname, "../../../fixtures/ifc/classified-wall-ifc4.ifc"),
    );
    const summary = await ifcLiteAdapter.loadModel({
      name: "classified.ifc",
      bytes: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
    });
    classified = summary.id;
  });

  const pick = async (over: Partial<ElementFilter>) =>
    (await ifcLiteAdapter.selectElements(classified, { ...EMPTY_ELEMENT_FILTER, ...over }))
      .map((match) => match.name)
      .sort();

  it("selects a code, a system, and a branch of codes", async () => {
    expect(await pick({ classificationCodes: ["Ss_25_10_30"] })).toEqual(["Wall A"]);
    expect(await pick({ classificationSystem: "Sistema Nacional" })).toEqual(["Wall A"]);
    expect(
      await pick({ classificationSystem: "Uniclass 2015", classificationCodes: ["Ss_25*"] }),
    ).toEqual(["Wall A", "Wall B"]);
  });

  it("does not take a code from one system as a code in another", async () => {
    expect(
      await pick({ classificationSystem: "Sistema Nacional", classificationCodes: ["Ss_25_10_30"] }),
    ).toEqual([]);
  });

  it("narrows an IFC class rather than replacing it", async () => {
    expect(await pick({ classes: ["IfcSlab"], classificationCodes: ["Ss_30*"] })).toEqual(["Slab A"]);
    expect(await pick({ classes: ["IfcSlab"], classificationCodes: ["Ss_25*"] })).toEqual([]);
  });

  it("selects a group defined by nothing but a classification", async () => {
    // `isEmptyElementFilter` refuses a blank filter, and must not count this as one.
    expect(await pick({ classificationSystem: "Uniclass 2015" })).toEqual([
      "Slab A",
      "Wall A",
      "Wall B",
    ]);
  });
});
