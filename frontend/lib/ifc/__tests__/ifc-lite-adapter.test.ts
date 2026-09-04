import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";
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
