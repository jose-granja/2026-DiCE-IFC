import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ifcLiteAdapter, resetIfcLiteAdapter } from "@/lib/ifc/ifc-lite-adapter";
import { computePlacements, deriveWorldOrigin, type FederationModelInput } from "../federation";

/**
 * A model in millimetres with `IfcMapConversion.Scale = 0.001` — the usual way an
 * authoring tool writes a millimetre project — drawn next to the same wall in
 * metres. Run through the real engine, because the failure was in how the
 * engine's units and the file's Scale combined, which a stub cannot show.
 */

const FIXTURES = path.resolve(__dirname, "../../../fixtures/ifc");

async function loaded(name: string): Promise<FederationModelInput & { wallMetres: [number, number, number] }> {
  const buffer = await readFile(path.join(FIXTURES, name));
  const summary = await ifcLiteAdapter.loadModel({
    name,
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  });
  const geometry = await ifcLiteAdapter.getGeometry(summary.id);
  const georeference = await ifcLiteAdapter.getGeoreferencing(summary.id);

  const wall = geometry.meshes.find((mesh) => (mesh.type ?? "").toLowerCase().includes("wall"))!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < wall.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], wall.positions[i + axis]);
      max[axis] = Math.max(max[axis], wall.positions[i + axis]);
    }
  }

  return {
    id: summary.id,
    name,
    coordinates: geometry.coordinates,
    georeference,
    wallMetres: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

afterAll(() => resetIfcLiteAdapter());

describe("a millimetre model with Scale = 0.001", () => {
  it("is drawn the same size as the same wall modelled in metres", async () => {
    const metres = await loaded("georeferenced-wall-ifc4.ifc");
    const millimetres = await loaded("millimetre-wall-ifc4.ifc");

    // The engine reports metres either way — that is the premise.
    expect(millimetres.georeference.lengthUnitScale).toBe(0.001);
    expect(millimetres.georeference.mapConversion?.scale).toBe(0.001);
    expect(millimetres.wallMetres[0]).toBeCloseTo(metres.wallMetres[0], 4);

    const placements = computePlacements([metres, millimetres], deriveWorldOrigin([metres, millimetres]));
    const sizeOnScreen = (input: typeof metres, scale: number) => input.wallMetres.map((v) => v * scale);

    const drawn = sizeOnScreen(millimetres, placements[1].scale);
    const reference = sizeOnScreen(metres, placements[0].scale);
    for (let axis = 0; axis < 3; axis += 1) expect(drawn[axis]).toBeCloseTo(reference[axis], 4);

    // 4 m long, 3 m high, 0.3 m thick — the dimensions the file states in mm.
    expect(drawn[0]).toBeCloseTo(4, 4);
    expect(drawn[1]).toBeCloseTo(3, 4);
  });

  it("lands where the metre model does", async () => {
    const metres = await loaded("georeferenced-wall-ifc4.ifc");
    const millimetres = await loaded("millimetre-wall-ifc4.ifc");
    const [a, b] = computePlacements([metres, millimetres], deriveWorldOrigin([metres, millimetres]));
    for (let axis = 0; axis < 3; axis += 1) expect(b.offset[axis]).toBeCloseTo(a.offset[axis], 4);
  });
});
