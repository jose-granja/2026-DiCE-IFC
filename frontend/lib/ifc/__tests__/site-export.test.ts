import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "../ifc-lite-adapter";

let bytes: ArrayBuffer;
let modelId = "";

beforeAll(async () => {
  const buffer = await readFile(path.resolve(__dirname, "../../../fixtures/ifc/georeferenced-wall-ifc4.ifc"));
  bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  modelId = (await ifcLiteAdapter.loadModel({ name: "wall.ifc", bytes })).id;
});

afterAll(() => resetIfcLiteAdapter());

async function reread(content: Uint8Array) {
  const copy = content.slice().buffer as ArrayBuffer;
  const summary = await ifcLiteAdapter.loadModel({ name: "out.ifc", bytes: copy });
  return ifcLiteAdapter.getGeoreferencing(summary.id);
}

describe("editing the IfcSite location", () => {
  it("writes a new latitude and longitude that read back", async () => {
    const before = await ifcLiteAdapter.getGeoreferencing(modelId);
    expect(before.site?.latitude).toBeCloseTo(41.55125, 4);

    const result = await ifcLiteAdapter.exportStep(modelId, {
      georeference: { site: { latitude: 51.90267650305555, longitude: 4.453894484166667 } },
    });
    expect(result.warnings).toEqual([]);

    const after = await reread(result.content);
    expect(after.site?.latitude).toBeCloseTo(51.9026765, 6);
    expect(after.site?.longitude).toBeCloseTo(4.4538945, 6);
    // Everything else about the site, and the map conversion, is as it was.
    expect(after.site?.elevation).toBe(before.site?.elevation);
    expect(after.mapConversion).toEqual(before.mapConversion);
  });

  it("writes a western longitude with its sign", async () => {
    const result = await ifcLiteAdapter.exportStep(modelId, {
      georeference: { site: { longitude: -9.1393 } },
    });
    const after = await reread(result.content);
    expect(after.site?.longitude).toBeCloseTo(-9.1393, 6);
    expect(after.site?.latitude).toBeCloseTo(41.55125, 4);
  });

  it("writes a new elevation as a real number", async () => {
    const result = await ifcLiteAdapter.exportStep(modelId, { georeference: { site: { elevation: 42.5 } } });
    expect(result.warnings).toEqual([]);
    const after = await reread(result.content);
    expect(after.site?.elevation).toBe(42.5);
    expect(after.site?.latitude).toBeCloseTo(41.55125, 4);
  });

  it("leaves the site alone when no site edit is asked for", async () => {
    const result = await ifcLiteAdapter.exportStep(modelId, {
      georeference: { mapConversion: { eastings: 1 } },
    });
    const after = await reread(result.content);
    expect(after.site?.latitude).toBeCloseTo(41.55125, 4);
  });
});
