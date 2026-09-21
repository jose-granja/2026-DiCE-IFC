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
