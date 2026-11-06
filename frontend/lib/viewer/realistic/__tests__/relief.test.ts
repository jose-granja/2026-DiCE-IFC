import { describe, expect, it } from "vitest";

import { estimateDetail, FAMILY_ROUGHNESS, packDetail } from "../relief";

/** A `side`² RGBA image, grey at `level(col, row)` (0–255). */
function image(side: number, level: (col: number, row: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const at = (row * side + col) * 4;
      out[at] = out[at + 1] = out[at + 2] = level(col, row);
      out[at + 3] = 255;
    }
  }
  return out;
}

const texel = (detail: Uint8ClampedArray, side: number, col: number, row: number) => {
  const at = (row * side + col) * 4;
  return { x: (detail[at] - 127.5) / 127.5, y: (detail[at + 1] - 127.5) / 127.5, rough: detail[at + 2] / 255, ao: detail[at + 3] };
};

describe("estimated relief", () => {
  it("is flat, at the family's roughness, for a photograph of one colour", () => {
    const detail = estimateDetail(image(16, () => 128), 16, 0.65, 8);
    for (let at = 0; at < detail.length; at += 4) {
      expect([detail[at], detail[at + 1], detail[at + 3]]).toEqual([128, 128, 255]);
      expect(detail[at + 2] / 255).toBeCloseTo(0.65, 2);
    }
  });

  it("reads the dark as deep: the normal leans away from a dark joint, in OpenGL's convention", () => {
    // A dark vertical joint at column 8, and a dark horizontal one at row 8.
    const side = 16;
    const columnJoint = estimateDetail(image(side, (col) => (col === 8 ? 40 : 200)), side, 0.85, side);
    // Right of the joint the face rises to the right, so its normal leans
    // back toward the joint: −x. Left of it, +x.
    expect(texel(columnJoint, side, 9, 4).x).toBeLessThan(-0.1);
    expect(texel(columnJoint, side, 7, 4).x).toBeGreaterThan(0.1);
    expect(Math.abs(texel(columnJoint, side, 9, 4).y)).toBeLessThan(1e-6 + 1 / 127.5);

    const rowJoint = estimateDetail(image(side, (_col, row) => (row === 8 ? 40 : 200)), side, 0.85, side);
    // Above the joint (smaller row, toward the image's top) the face rises
    // toward the top, so the normal leans down toward the joint: −y.
    expect(texel(rowJoint, side, 4, 7).y).toBeLessThan(-0.1);
    expect(texel(rowJoint, side, 4, 9).y).toBeGreaterThan(0.1);
    // The joint is rougher than the brick round it.
    expect(texel(rowJoint, side, 4, 8).rough).toBeGreaterThan(texel(rowJoint, side, 4, 3).rough);
  });

  it("wraps round the edges, as the textures tile", () => {
    const side = 16;
    // A joint on the first column: the last column is its left neighbour.
    const detail = estimateDetail(image(side, (col) => (col === 0 ? 40 : 200)), side, 0.85, side);
    expect(texel(detail, side, side - 1, 4).x).toBeGreaterThan(0.1);
    expect(texel(detail, side, 1, 4).x).toBeLessThan(-0.1);
  });

  it("averages a larger photograph down to the relief's size", () => {
    const detail = estimateDetail(image(32, () => 90), 32, FAMILY_ROUGHNESS.concrete, 8);
    expect(detail).toHaveLength(8 * 8 * 4);
  });
});

describe("published maps", () => {
  it("packs the normal's x and y with arm's roughness and occlusion", () => {
    const normal = new Uint8ClampedArray([10, 20, 255, 255]);
    const arm = new Uint8ClampedArray([200, 150, 0, 255]);
    expect([...packDetail(normal, arm)]).toEqual([10, 20, 150, 200]);
  });
});
