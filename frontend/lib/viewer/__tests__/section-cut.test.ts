import { describe, expect, it } from "vitest";

import { cutRegions, type CutBatch } from "../section-cut";

/** Plane z = 0.5, 2D coordinates are plain x/y. */
const PLANE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1];

/** Axis-aligned box as 12 triangles; `flip` reverses every triangle's winding. */
function box(min: number, max: number, flip = false) {
  const p = [
    [min, min, min],
    [max, min, min],
    [max, max, min],
    [min, max, min],
    [min, min, max],
    [max, min, max],
    [max, max, max],
    [min, max, max],
  ];
  const tri = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return {
    positions: p.flat(),
    indices: tri.flatMap(([a, b, c]) => (flip ? [a, c, b] : [a, b, c])),
  };
}

function batch(geometry: { positions: number[]; indices: number[] }, id = 1): CutBatch {
  return {
    positions: geometry.positions,
    indices: geometry.indices,
    entityIds: new Array(geometry.positions.length / 3).fill(id),
    scope: "m",
  };
}

describe("cutRegions", () => {
  it("returns the cross-section of a closed solid", () => {
    const { regions } = cutRegions([batch(box(0, 1))], PLANE);
    expect(regions).toHaveLength(1);
    // Extra collinear points appear where a face's diagonal is crossed.
    expect(regions[0].outer.length).toBeGreaterThanOrEqual(4);
    expect(regions[0].holes).toHaveLength(0);
  });

  it("does not care which way each triangle winds", () => {
    const { regions } = cutRegions([batch(box(0, 1, true))], PLANE);
    expect(regions).toHaveLength(1);
  });

  it("finds nothing when the plane misses the solid", () => {
    const { regions, loops } = cutRegions([batch(box(2, 3))], PLANE);
    expect(regions).toHaveLength(0);
    expect(loops).toHaveLength(0);
  });

  it("leaves a hollow element's void as a hole", () => {
    const outer = box(0, 3);
    const inner = box(1, 2);
    const merged = {
      positions: [...outer.positions, ...inner.positions],
      indices: [...outer.indices, ...inner.indices.map((i) => i + 8)],
    };
    const { regions } = cutRegions([batch(merged)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1.5, 1]);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });

  it("never fills an open sheet, however it crosses the plane", () => {
    // A vertical glass pane: one quad standing across the plane.
    const pane = {
      positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const { regions } = cutRegions([batch(pane)], PLANE);
    expect(regions).toHaveLength(0);
  });

  it("unions separate elements instead of nesting them", () => {
    const wall = box(0, 3);
    const frame = box(1, 2);
    const result = cutRegions(
      [batch(wall, 1), batch(frame, 2)],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1.5, 1],
    );
    expect(result.regions).toHaveLength(2);
    expect(result.regions.every((region) => region.holes.length === 0)).toBe(true);
  });

  it("draws a glazing sheet's crossing as a line when asked to keep open cuts", () => {
    const pane = {
      positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    };
    const kept = cutRegions([{ ...batch(pane), keepOpen: true }], PLANE);
    expect(kept.regions).toHaveLength(0);
    expect(kept.lines.length).toBeGreaterThan(0);
    expect(cutRegions([batch(pane)], PLANE).lines).toHaveLength(0);
  });

  it("does not repeat a closed outline as loose lines", () => {
    const { lines } = cutRegions([{ ...batch(box(0, 1)), keepOpen: true }], PLANE);
    expect(lines).toHaveLength(0);
  });
});
