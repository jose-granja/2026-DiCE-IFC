import { describe, expect, it } from "vitest";

import type { MeshView } from "@/lib/ifc/types";
import { mergeMeshes } from "../batching";
import { featureEdgeMasks } from "../edges";

/** Two triangles forming a flat unit square in z = 0, sharing the 0-2 diagonal. */
const FLAT = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
};

/** Same two triangles, folded 90° along the shared diagonal. */
const FOLDED = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
};

const bits = (n: number) => [n & 1, (n >> 1) & 1, (n >> 2) & 1];

describe("featureEdgeMasks", () => {
  it("flags the rim of a flat patch but not its triangulation diagonal", () => {
    const [a, b] = featureEdgeMasks(FLAT.positions, FLAT.indices);
    // Triangle 0 = (0,1,2): its diagonal 0-2 is the edge opposite corner 1.
    expect(bits(a)).toEqual([1, 0, 1]);
    // Triangle 1 = (0,2,3): the diagonal 0-2 is the edge opposite corner 2.
    expect(bits(b)).toEqual([1, 1, 0]);
  });

  it("flags a fold between two faces", () => {
    const [a, b] = featureEdgeMasks(FOLDED.positions, FOLDED.indices);
    expect(bits(a)[1]).toBe(1);
    expect(bits(b)[2]).toBe(1);
  });

  it("ignores which way a triangle winds", () => {
    const flipped = [...FLAT.indices.slice(0, 3), 0, 3, 2];
    const [a] = featureEdgeMasks(FLAT.positions, flipped);
    expect(bits(a)[1]).toBe(0);
  });

  it("treats duplicated vertices on a shared edge as the same edge", () => {
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, /* copy */ 0, 0, 0, 1, 1, 0, 0, 1, 0];
    const [a] = featureEdgeMasks(positions, [0, 1, 2, 3, 4, 5]);
    expect(bits(a)[1]).toBe(0);
  });

  it("leaves a gentle bend (a curved surface's facets) unflagged", () => {
    const angle = (10 * Math.PI) / 180;
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1 + Math.cos(angle), 1, Math.sin(angle)];
    const [a] = featureEdgeMasks(positions, [0, 1, 2, 1, 4, 2]);
    // Edge 1-2 is shared by both triangles, opposite corner 0 of the first.
    expect(bits(a)[0]).toBe(0);
  });
});

describe("mergeMeshes with edges", () => {
  const mesh: MeshView = {
    expressId: 5,
    origin: [10, 0, 0],
    positions: new Float32Array(FLAT.positions),
    normals: new Float32Array(12).fill(0),
    indices: new Uint32Array(FLAT.indices),
    color: [1, 1, 1, 1],
  };

  it("gives every triangle corner its own vertex", () => {
    const merged = mergeMeshes([mesh], { edges: true });
    expect(merged.positions.length / 3).toBe(6);
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(merged.edgeMask).toHaveLength(6);
    // Origin baked in, indices resolved: vertex 3 is the second triangle's first corner.
    expect(Array.from(merged.positions.slice(9, 12))).toEqual([10, 0, 0]);
    expect(merged.spans.get(5)).toEqual([{ start: 0, count: 6 }]);
  });

  it("keeps shared vertices when edges are not wanted", () => {
    const merged = mergeMeshes([mesh]);
    expect(merged.positions.length / 3).toBe(4);
    expect(merged.edgeMask).toBeUndefined();
  });
});
