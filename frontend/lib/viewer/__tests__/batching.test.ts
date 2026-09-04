import { describe, expect, it } from "vitest";

import type { MeshView, Vec3 } from "@/lib/ifc/types";
import { mergeMeshes, planBatches, visibleIndices } from "../batching";

/** A unit triangle, so offsets and rebasing are easy to read in assertions. */
function triangle(
  expressId: number,
  origin: Vec3 = [0, 0, 0],
  color: [number, number, number, number] = [1, 0, 0, 1],
): MeshView {
  return {
    expressId,
    origin,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  };
}

describe("planBatches", () => {
  it("keeps everything in one batch when it fits", () => {
    expect(planBatches([triangle(1), triangle(2)], 100)).toHaveLength(1);
  });

  it("splits when the vertex cap is exceeded", () => {
    // Three triangles, 3 vertices each, cap of 6 → two batches.
    const groups = planBatches([triangle(1), triangle(2), triangle(3)], 6);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it("gives an oversized mesh its own batch rather than dropping it", () => {
    const groups = planBatches([triangle(1), triangle(2)], 1);
    expect(groups).toHaveLength(2);
    expect(groups.flat()).toHaveLength(2);
  });

  it("handles no meshes", () => {
    expect(planBatches([])).toEqual([]);
  });
});

describe("mergeMeshes", () => {
  it("bakes each mesh's origin into its vertices", () => {
    const merged = mergeMeshes([triangle(1, [10, 20, 30])]);
    expect([...merged.positions.slice(0, 3)]).toEqual([10, 20, 30]);
    expect([...merged.positions.slice(3, 6)]).toEqual([11, 20, 30]);
  });

  it("rebases indices onto each mesh's vertex offset", () => {
    const merged = mergeMeshes([triangle(1), triangle(2)]);

    // First triangle keeps 0,1,2; the second must become 3,4,5 or it draws
    // the first triangle twice and leaves the second's vertices unreferenced.
    expect([...merged.indices]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never emits an index outside the merged vertex buffer", () => {
    const merged = mergeMeshes([triangle(1), triangle(2), triangle(3)]);
    const vertexCount = merged.positions.length / 3;
    for (const index of merged.indices) {
      expect(index).toBeLessThan(vertexCount);
    }
  });

  it("tags every vertex with its entity, for picking", () => {
    const merged = mergeMeshes([triangle(7), triangle(9)]);
    expect([...merged.entityIds]).toEqual([7, 7, 7, 9, 9, 9]);
  });

  it("records a vertex span per entity", () => {
    const merged = mergeMeshes([triangle(7), triangle(9)]);
    expect(merged.spans.get(7)).toEqual([{ start: 0, count: 3 }]);
    expect(merged.spans.get(9)).toEqual([{ start: 3, count: 3 }]);
  });

  it("accumulates spans when one entity contributes several meshes", () => {
    // A layered wall arrives as one MeshData per material layer.
    const merged = mergeMeshes([triangle(7), triangle(7)]);
    expect(merged.spans.get(7)).toEqual([
      { start: 0, count: 3 },
      { start: 3, count: 3 },
    ]);
  });

  it("carries the authored colour to every vertex", () => {
    const merged = mergeMeshes([triangle(1, [0, 0, 0], [0.2, 0.4, 0.6, 1])]);
    expect([...merged.colours.slice(0, 3)]).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.4, 5),
      expect.closeTo(0.6, 5),
    ]);
  });

  it("blends toward the model tint by the given amount", () => {
    const merged = mergeMeshes([triangle(1, [0, 0, 0], [0, 0, 0, 1])], {
      tint: [1, 1, 1],
      tintAmount: 0.5,
    });
    expect(merged.colours[0]).toBeCloseTo(0.5, 5);
  });

  it("leaves colours untouched at tintAmount 0", () => {
    const merged = mergeMeshes([triangle(1, [0, 0, 0], [0.25, 0, 0, 1])], {
      tint: [1, 1, 1],
      tintAmount: 0,
    });
    expect(merged.colours[0]).toBeCloseTo(0.25, 5);
  });

  it("merges nothing into empty buffers rather than throwing", () => {
    const merged = mergeMeshes([]);
    expect(merged.positions).toHaveLength(0);
    expect(merged.indices).toHaveLength(0);
    expect(merged.spans.size).toBe(0);
  });
});

describe("visibleIndices", () => {
  it("keeps only triangles whose entity is visible", () => {
    const merged = mergeMeshes([triangle(1), triangle(2)]);
    const kept = visibleIndices(
      merged.indices,
      merged.entityIds,
      (id) => id === 2,
    );
    expect([...kept]).toEqual([3, 4, 5]);
  });

  it("keeps everything when nothing is hidden", () => {
    const merged = mergeMeshes([triangle(1), triangle(2)]);
    expect(
      visibleIndices(merged.indices, merged.entityIds, () => true),
    ).toHaveLength(merged.indices.length);
  });

  it("keeps nothing when everything is hidden", () => {
    const merged = mergeMeshes([triangle(1)]);
    expect(
      visibleIndices(merged.indices, merged.entityIds, () => false),
    ).toHaveLength(0);
  });

  it("asks about each entity once, not once per triangle", () => {
    const meshes = [triangle(1), triangle(1), triangle(2)];
    const merged = mergeMeshes(meshes);

    const asked: number[] = [];
    visibleIndices(merged.indices, merged.entityIds, (id) => {
      asked.push(id);
      return true;
    });

    // Three triangles, two entities.
    expect(asked).toEqual([1, 2]);
  });
});
