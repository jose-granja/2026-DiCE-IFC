import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ifcLiteAdapter } from "../ifc-lite-adapter";
import type { MeshView } from "../types";

async function geometryFor(file: string) {
  const buffer = await readFile(file);
  const model = await ifcLiteAdapter.loadModel({
    name: path.basename(file),
    bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
  try {
    return await ifcLiteAdapter.getGeometry(model.id);
  } finally {
    await ifcLiteAdapter.unloadModel(model.id);
  }
}

function bounds(meshes: MeshView[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) {
      const axis = i % 3;
      const value = mesh.positions[i] + mesh.origin[axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

describe("IFC4x3 alignment geometry", () => {
  it("meshes sectioned solids and places bearings at the gradient elevation", async () => {
    const { meshes } = await geometryFor(
      path.resolve(__dirname, "../../../fixtures/ifc/alignment-bridge-ifc4x3.ifc"),
    );
    const girder = meshes.filter((mesh) => mesh.expressId === 48);
    const bearing = meshes.filter((mesh) => mesh.expressId === 58);
    expect(girder.length).toBeGreaterThan(0);
    expect(bearing.length).toBeGreaterThan(0);

    // Render Y is IFC Z. The old engine omitted the girder and put the bearing at Y=0.
    const girderBounds = bounds(girder);
    expect(girderBounds.min[0]).toBeCloseTo(0, 3);
    expect(girderBounds.max[0]).toBeCloseTo(20, 3);
    expect(girderBounds.min[1]).toBeCloseTo(49.5, 3);
    expect(girderBounds.max[1]).toBeCloseTo(50.5, 3);

    const bearingBounds = bounds(bearing);
    expect(bearingBounds.min[0]).toBeCloseTo(9.5, 3);
    expect(bearingBounds.max[0]).toBeCloseTo(10.5, 3);
    expect(bearingBounds.min[1]).toBeCloseTo(50, 3);
    expect(bearingBounds.max[1]).toBeCloseTo(50.5, 3);
  });

  // Keep the real model local: no download and no copy committed to the repository.
  it.skipIf(!process.env.ACERNO_IFC)("renders the complete Viadotto Acerno superstructure", async () => {
    const { meshes } = await geometryFor(process.env.ACERNO_IFC!);
    for (const [type, count] of [
      ["IfcBeam", 590],
      ["IfcSlab", 41],
      ["IfcCourse", 38],
      ["IfcPavement", 2],
      ["IfcBearing", 152],
    ] as const) {
      const selected = meshes.filter((mesh) => mesh.type === type);
      expect(new Set(selected.map((mesh) => mesh.expressId)).size, type).toBe(count);
      // Slabs also include low foundation components. Beams and bearings
      // specifically follow the deck alignment, around 50 m above project zero.
      if (type === "IfcBeam" || type === "IfcBearing") {
        const box = bounds(selected);
        expect(box.min[1], `${type} elevation`).toBeGreaterThan(40);
        expect(box.max[1], `${type} elevation`).toBeLessThan(60);
      }
    }
  });
});
