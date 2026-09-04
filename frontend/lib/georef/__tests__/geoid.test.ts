import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { egm96Undulation, toEllipsoidalHeight, type Egm96Grid } from "../geoid";

/** 3×3 patch around a known cell, values in centimetres — enough to exercise
 * bilinear interpolation and the 360°→0° wraparound without the real asset. */
function syntheticGrid(): Egm96Grid {
  const rows = 181;
  const cols = 360;
  const grid = new Int16Array(rows * cols);
  // Row 40 = latitude 50°N. A ramp so interpolation between distinct corners
  // is checkable by hand, plus a value at col 359 that must differ from col 0
  // so the wraparound test can tell them apart.
  grid[40 * cols + 0] = 1000; // 10.00 m at (50°N, 0°E)
  grid[40 * cols + 1] = 2000; // 20.00 m at (50°N, 1°E)
  grid[41 * cols + 0] = 3000; // 30.00 m at (49°N, 0°E)
  grid[41 * cols + 1] = 4000; // 40.00 m at (49°N, 1°E)
  grid[40 * cols + 359] = 500; // 5.00 m at (50°N, -1°E / 359°E)
  return grid;
}

describe("egm96Undulation", () => {
  it("is 0 (a no-op correction) when the grid has not loaded", () => {
    expect(egm96Undulation(null, 41.5, -8.4)).toBe(0);
  });

  it("returns the exact grid value at a grid point", () => {
    const grid = syntheticGrid();
    expect(egm96Undulation(grid, 50, 0)).toBeCloseTo(10, 6);
    expect(egm96Undulation(grid, 49, 1)).toBeCloseTo(40, 6);
  });

  it("bilinearly interpolates between the four surrounding points", () => {
    const grid = syntheticGrid();
    // Centre of the (50°N,0°E)-(49°N,1°E) cell: mean of the four corners.
    expect(egm96Undulation(grid, 49.5, 0.5)).toBeCloseTo((10 + 20 + 30 + 40) / 4, 6);
  });

  it("wraps longitude across the 360°/0° seam", () => {
    const grid = syntheticGrid();
    // -1° and 359° must resolve to the same stored column.
    expect(egm96Undulation(grid, 50, -1)).toBeCloseTo(5, 6);
    expect(egm96Undulation(grid, 50, 359)).toBeCloseTo(5, 6);
    // Interpolating from that column towards 0° must land strictly between
    // the two distinct corner values (5 and 10), not repeat one of them.
    const between = egm96Undulation(grid, 50, -0.5);
    expect(between).toBeGreaterThan(5);
    expect(between).toBeLessThan(10);
  });
});

describe("toEllipsoidalHeight", () => {
  it("adds the undulation to the orthometric height", () => {
    const grid = syntheticGrid();
    expect(toEllipsoidalHeight(grid, 50, 0, 100)).toBeCloseTo(110, 6);
  });

  it("passes the height through unchanged with no grid", () => {
    expect(toEllipsoidalHeight(null, 50, 0, 100)).toBe(100);
  });
});

/**
 * The bundled asset, read straight off disk (not via `fetch`, which jsdom/
 * node doesn't serve `public/` through) — this is what actually ships.
 *
 * Guards against a future regeneration of the grid silently changing sign,
 * byte order or extent. The expected value is EGM96 at mainland Portugal
 * (mid-40s N, single digits W): positive and around 50 m, which is also the
 * fact behind the bug this module fixes — an IfcSite RefElevation there is
 * that far from Cesium's ellipsoidal height if never corrected.
 */
describe("the bundled EGM96 grid", () => {
  it("reads a plausible undulation for mainland Portugal", () => {
    const bytes = readFileSync(join(__dirname, "../../../public/geoid/egm96-1deg.bin"));
    const grid = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / Int16Array.BYTES_PER_ELEMENT,
    );

    const undulation = egm96Undulation(grid, 38.7, -9.14); // near Lisbon
    expect(undulation).toBeGreaterThan(40);
    expect(undulation).toBeLessThan(65);
  });
});
