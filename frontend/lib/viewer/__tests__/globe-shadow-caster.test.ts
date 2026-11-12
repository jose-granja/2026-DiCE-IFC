import { describe, expect, it } from "vitest";

import { cellSize, globeShadowCaster, MARGIN, MIN_DROP, type SurfaceMesh } from "../globe-shadow-caster";

/** A flat grid at `height`, `steps` cells a side over `across` metres, centred on the origin — as `sampleDepthProxy` lays it out. */
function grid(across: number, steps: number, height = 0): SurfaceMesh {
  const positions: number[] = [];
  for (let row = 0; row <= steps; row += 1) {
    for (let column = 0; column <= steps; column += 1) {
      positions.push(-across / 2 + (across * column) / steps, height, -across / 2 + (across * row) / steps);
    }
  }
  const indices: number[] = [];
  const at = (row: number, column: number) => row * (steps + 1) + column;
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      indices.push(at(row, column), at(row + 1, column), at(row, column + 1));
      indices.push(at(row, column + 1), at(row + 1, column), at(row + 1, column + 1));
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Whether any kept triangle has its centre within `distance` of the point (x, z). */
function castsNear(caster: SurfaceMesh, x: number, z: number, distance: number): boolean {
  for (let triangle = 0; triangle < caster.indices.length; triangle += 3) {
    let cx = 0;
    let cz = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      cx += caster.positions[caster.indices[triangle + corner] * 3] / 3;
      cz += caster.positions[caster.indices[triangle + corner] * 3 + 2] / 3;
    }
    if (Math.hypot(cx - x, cz - z) < distance) return true;
  }
  return false;
}

describe("globeShadowCaster", () => {
  it("measures the grid's cell", () => {
    expect(cellSize(grid(100, 10))).toBeCloseTo(10);
  });

  it("lies below the surface it stands for: at least a metre and a half, more on a coarse grid", () => {
    const fine = globeShadowCaster(grid(100, 100, 50), [])!;
    expect(Math.max(...fine.positions.filter((_, at) => at % 3 === 1))).toBeCloseTo(50 - MIN_DROP);
    const coarse = globeShadowCaster(grid(4800, 48, 50), [])!;
    expect(coarse.positions[1]).toBeCloseTo(50 - 0.15 * 100);
  });

  it("leaves the surface it was made from alone", () => {
    const surface = grid(100, 10, 20);
    globeShadowCaster(surface, [{ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }]);
    expect(surface.positions[1]).toBe(20);
    expect(surface.indices.length).toBe(200 * 3);
  });

  it("casts nothing over a model, so today's building on the site cannot shade the new one", () => {
    const caster = globeShadowCaster(grid(200, 100), [{ minX: 10, maxX: 30, minZ: -10, maxZ: 10 }])!;
    expect(castsNear(caster, 20, 0, 10 + MARGIN)).toBe(false);
    // Clear of it, it casts.
    expect(castsNear(caster, -40, 0, 3)).toBe(true);
    expect(castsNear(caster, 20, 40, 3)).toBe(true);
  });

  it("drops a coarse cell that spans a model with no corner inside it", () => {
    // 400 m cells, a 10 m model in the middle of one.
    const caster = globeShadowCaster(grid(1600, 4), [{ minX: 195, maxX: 205, minZ: 195, maxZ: 205 }])!;
    expect(caster.indices.length).toBe((4 * 4 * 2 - 2) * 3);
  });

  it("leaves to a finer copy the ground it covers", () => {
    const covered = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
    const caster = globeShadowCaster(grid(1000, 10), [], covered)!;
    expect(castsNear(caster, 0, 0, 100)).toBe(false);
    expect(castsNear(caster, 0, 300, 60)).toBe(true);
    // Only the cells whose centre is inside: 2 × 2 of the 100 m grid.
    expect(caster.indices.length).toBe((200 - 8) * 3);
  });

  it("has nothing to cast when the models cover the whole surface", () => {
    expect(globeShadowCaster(grid(10, 2), [{ minX: -50, maxX: 50, minZ: -50, maxZ: 50 }])).toBeNull();
  });
});
