import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";
import type { ElementGroupSource } from "../types";

async function load(name: string) {
  const buffer = await readFile(path.resolve(__dirname, "../../../fixtures/ifc", name));
  return ifcLiteAdapter.loadModel({
    name,
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  });
}

afterAll(() => resetIfcLiteAdapter());

/** Group sizes by value, the way a lens legend reads them. */
async function sizes(modelId: string, source: ElementGroupSource) {
  const groups = await ifcLiteAdapter.groupElementsByValue(modelId, source);
  return Object.fromEntries(groups.map((group) => [group.value, group.expressIds.length]));
}

describe("grouping elements by a value, for a lens", () => {
  it("groups by class, largest first", async () => {
    const { id } = await load("georeferenced-wall-ifc4.ifc");
    const groups = await ifcLiteAdapter.groupElementsByValue(id, { kind: "class" });
    expect(groups.map((group) => group.value)).toEqual(["IfcWall", "IfcSlab"]);
  });

  it("groups by a property's value, booleans as IDS writes them", async () => {
    const { id } = await load("georeferenced-wall-ifc4.ifc");
    expect(await sizes(id, { kind: "property", setName: "Pset_WallCommon", propertyName: "IsExternal" })).toEqual({
      TRUE: 1,
      FALSE: 1,
    });
    // An element without the property is in no group — the lens ghosts it.
    expect(await sizes(id, { kind: "property", setName: "Pset_WallCommon", propertyName: "FireRating" })).toEqual({
      "REI 60": 1,
    });
  });

  it("groups by predefined type", async () => {
    const { id } = await load("georeferenced-wall-ifc4.ifc");
    const groups = await sizes(id, { kind: "predefinedType" });
    expect(groups.STANDARD).toBe(2);
  });

  it("groups by storey, with everything beneath each", async () => {
    const { id } = await load("facets-ifc4.ifc");
    const groups = await ifcLiteAdapter.groupElementsByValue(id, { kind: "storey" });
    expect(groups.length).toBe(2);
    expect(groups.reduce((total, group) => total + group.expressIds.length, 0)).toBe(3);
  });

  it("groups by classification code, in one system or all", async () => {
    const { id } = await load("classified-wall-ifc4.ifc");
    expect(await sizes(id, { kind: "classification", system: "Uniclass 2015" })).toEqual({
      "Ss_25_10_30 · Framed wall systems": 1,
      "Ss_25_10_60 · Solid wall systems": 1,
      "Ss_30_10_30 · Floor structure systems": 1,
    });
    // Without a system, Wall A is in both of its systems' groups.
    expect(await sizes(id, { kind: "classification" })).toMatchObject({ "EF_25_10 · Paredes": 1 });
  });
});
