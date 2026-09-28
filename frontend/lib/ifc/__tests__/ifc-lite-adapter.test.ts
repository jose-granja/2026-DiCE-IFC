import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ifcLiteAdapter,
  resetIfcLiteAdapter,
  resolveRenderOriginShift,
} from "../ifc-lite-adapter";
import { runAdapterConformance, type ConformanceFixtures } from "../conformance";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/ifc");

async function load(name: string) {
  const buffer = await readFile(path.join(FIXTURES, name));
  return {
    name,
    bytes: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  };
}

const fixtures: ConformanceFixtures = {
  ifc4: await load("georeferenced-wall-ifc4.ifc"),
  ifc4x3: await load("bridge-ifc4x3.ifc"),
};

afterAll(() => {
  resetIfcLiteAdapter();
});

runAdapterConformance(ifcLiteAdapter, fixtures);

describe("geometry coordinate metadata", () => {
  it("combines the IFC Z-up WASM RTC offset with the later render shift", () => {
    expect(
      resolveRenderOriginShift({
        originShift: { x: 1, y: 2, z: 3 },
        wasmRtcOffset: { x: 100, y: 200, z: 5 },
      }),
    ).toEqual([101, 7, -197]);
  });
});

describe("quantity queries", () => {
  it("filters occurrences and combines occurrence quantities with type properties", async () => {
    const summary = await ifcLiteAdapter.loadModel(await load("facets-ifc4.ifc"));
    try {
      const vocabulary = await ifcLiteAdapter.getVocabulary(summary.id);
      expect(vocabulary.quantitySets).toContainEqual({
        name: "Qto_WallBaseQuantities",
        quantities: ["NetSideArea"],
      });

      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: [],
          objectTypes: [],
          materials: ["Concrete C30/37"],
          properties: [
            {
              setName: "Pset_WallCommon",
              propertyName: "LoadBearing",
              operator: "equals",
              value: "TRUE",
            },
          ],
        },
        sources: [
          {
            id: "area",
            alias: "area",
            kind: "quantity",
            setName: "Qto_WallBaseQuantities",
            valueName: "NetSideArea",
          },
          {
            id: "u_value",
            alias: "u_value",
            kind: "property",
            setName: "Pset_WallCommon",
            valueName: "ThermalTransmittance",
          },
        ],
        formula: "area * u_value",
      });

      expect(result.matchedCount).toBe(2);
      expect(result.missingValueCount).toBe(0);
      expect(result.rows.map((row) => row.value)).toEqual([2.25, 2.25]);
      expect(result.total).toBe(4.5);

      const alternatives = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: [],
          objectTypes: [],
          materials: [],
          propertyCombination: "any",
          properties: [
            {
              setName: "Pset_WallCommon",
              propertyName: "LoadBearing",
              operator: "equals",
              value: "TRUE",
            },
            {
              setName: "Pset_DoorCommon",
              propertyName: "IsExternal",
              operator: "equals",
              value: "TRUE",
            },
          ],
        },
        sources: [{ id: "count", alias: "count", kind: "count" }],
      });
      expect(alternatives.total).toBe(2);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });

  it("filters by occurrence PredefinedType", async () => {
    const summary = await ifcLiteAdapter.loadModel(
      await load("georeferenced-wall-ifc4.ifc"),
    );
    try {
      const result = await ifcLiteAdapter.evaluateQuantityQuery(summary.id, {
        filters: {
          classes: ["IfcWall"],
          predefinedTypes: ["STANDARD"],
          objectTypes: [],
          materials: [],
          properties: [],
        },
        sources: [{ id: "count", alias: "count", kind: "count" }],
      });

      expect(result.matchedCount).toBe(2);
      expect(result.total).toBe(2);
      expect(result.rows.every((row) => row.predefinedType === "STANDARD")).toBe(true);
    } finally {
      await ifcLiteAdapter.unloadModel(summary.id);
    }
  });
});
