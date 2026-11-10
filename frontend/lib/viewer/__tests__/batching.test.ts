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

  it("keeps transparent geometry in a separate render batch", () => {
    const opaque = triangle(1);
    const glass = triangle(2, [0, 0, 0], [0.7, 0.8, 0.9, 0.35]);

    const groups = planBatches([glass, opaque], 100);

    expect(groups).toEqual([[opaque], [glass]]);
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
    const merged = mergeMeshes([triangle(1, [0, 0, 0], [0.2, 0.4, 0.6, 0.5])]);
    expect([...merged.colours.slice(0, 4)]).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.4, 5),
      expect.closeTo(0.6, 5),
      expect.closeTo(0.35, 5),
    ]);
    expect(merged.transparent).toBe(true);
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

describe("the model's own textures", () => {
  const textured = (expressId: number, key: string): MeshView => ({
    ...triangle(expressId),
    uvs: new Float32Array([0, 1, 1, 1, 0, 0]),
    texture: { key, repeatS: true, repeatT: true, url: `${key}.png` },
  });

  it("gives each texture batches of its own, after the untextured ones", () => {
    const plain = triangle(1);
    const brick = textured(2, "ref:10");
    const wood = textured(3, "ref:11");
    const brick2 = textured(4, "ref:10");
    expect(planBatches([brick, plain, wood, brick2], 100)).toEqual([[plain], [brick, brick2], [wood]]);
  });

  it("treats a texture without coordinates as no texture", () => {
    const loose = { ...textured(2, "ref:10"), uvs: undefined };
    expect(planBatches([triangle(1), loose], 100)).toEqual([[triangle(1), loose]]);
  });

  it("carries the coordinates and the texture into the merged batch", () => {
    const merged = mergeMeshes([textured(2, "ref:10"), textured(4, "ref:10")]);
    expect(merged.texture?.key).toBe("ref:10");
    expect([...merged.uvs!]).toEqual([0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0]);
    expect(mergeMeshes([triangle(1)]).uvs).toBeUndefined();
  });

  it("gives every corner its coordinate when triangles are unshared for edges", () => {
    // A quad of two triangles sharing an edge: corners repeat when unshared.
    const quad: MeshView = {
      ...textured(5, "ref:12"),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    };
    const merged = mergeMeshes([quad], { edges: true });
    expect([...merged.uvs!]).toEqual([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]);
  });
});
