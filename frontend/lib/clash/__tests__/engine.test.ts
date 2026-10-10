import { describe, expect, it } from "vitest";

import { detectClashes } from "../engine";
import {
  DEFAULT_CLASH_SETTINGS,
  type ClashElementGeometry,
  type ClashSettings,
  type ClashTask,
  type Vec3,
} from "../types";

/** Axis-aligned box as 12 triangles. */
function box(key: string, min: Vec3, max: Vec3, modelId = "m"): ClashElementGeometry {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, positions, indices, modelId };
}

const task = (over: Partial<ClashTask> = {}): ClashTask => ({
  id: "t",
  a: ["a"],
  b: ["b"],
  mode: "hard",
  horizontal: 0,
  vertical: 0,
  clearance: 0,
  useVolume: false,
  volume: 0.01,
  ...over,
});

const settings = (over: Partial<ClashSettings> = {}): ClashSettings => ({
  ...DEFAULT_CLASH_SETTINGS,
  ...over,
});

describe("detectClashes", () => {
  it("finds two boxes that cross, and where", () => {
    const { hits } = detectClashes(
      [box("a", [0, 0, 0], [2, 2, 2]), box("b", [1, 1, 1], [3, 3, 3])],
      [task()],
      settings(),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("hard");
    expect(hits[0].point[0]).toBeCloseTo(1.5, 1);
    expect(hits[0].extent[0]).toBeGreaterThan(0.8);
  });

  it("does not call touching faces a clash", () => {
    const { hits } = detectClashes(
      [box("a", [0, 0, 0], [1, 1, 1]), box("b", [1, 0, 0], [2, 1, 1])],
      [task()],
      settings(),
    );
    expect(hits).toHaveLength(0);
  });

  it("ignores an overlap that is not deeper than the tolerance", () => {
    // 5 mm deep, but 0.6 m across.
    const geometry = [box("a", [0, 0, 0], [1, 1, 1]), box("b", [0.995, 0.2, 0.2], [2, 0.8, 0.8])];
    expect(detectClashes(geometry, [task()], settings()).hits).toHaveLength(1);
    expect(detectClashes(geometry, [task({ horizontal: 0.001, vertical: 0.001 })], settings()).hits).toHaveLength(1);
    expect(detectClashes(geometry, [task({ horizontal: 0.01, vertical: 0.01 })], settings()).hits).toHaveLength(0);
  });

  it("reports an element that is too close under a clearance tolerance", () => {
    const geometry = [box("a", [0, 0, 0], [1, 1, 1]), box("b", [1.1, 0, 0], [2, 1, 1])];

    const close = detectClashes(geometry, [task({ mode: "clearance", clearance: 0.2 })], settings());
    expect(close.hits).toHaveLength(1);
    expect(close.hits[0].kind).toBe("clearance");
    expect(close.hits[0].distance).toBeCloseTo(0.1, 3);

    expect(
      detectClashes(geometry, [task({ mode: "clearance", clearance: 0.05 })], settings()).hits,
    ).toHaveLength(0);
  });

  it("finds an element sitting entirely inside another", () => {
    const geometry = [box("a", [0, 0, 0], [4, 4, 4]), box("b", [1, 1, 1], [2, 2, 2])];
    const inside = detectClashes(geometry, [task()], settings());
    expect(inside.hits).toHaveLength(1);
    expect(inside.hits[0].kind).toBe("inside");
    expect(detectClashes(geometry, [task()], settings({ checkInside: false })).hits).toHaveLength(0);
  });

  it("finds duplicates", () => {
    const geometry = [box("a", [0, 0, 0], [1, 1, 1]), box("b", [0, 0, 0], [1, 1, 1])];
    expect(detectClashes(geometry, [task()], settings()).hits[0].kind).toBe("duplicate");
    expect(
      detectClashes(geometry, [task()], settings({ checkDuplicate: false, checkInside: false })).hits,
    ).toHaveLength(0);
  });

  it("skips elements of the same model when asked", () => {
    const geometry = [
      box("a", [0, 0, 0], [2, 2, 2], "m1"),
      box("b", [1, 1, 1], [3, 3, 3], "m1"),
    ];
    expect(detectClashes(geometry, [task()], settings({ ignoreSameModel: true })).hits).toHaveLength(0);
    expect(detectClashes(geometry, [task()], settings()).hits).toHaveLength(1);
  });

  it("tests a pair once however many rules ask for it", () => {
    const geometry = [box("a", [0, 0, 0], [2, 2, 2]), box("b", [1, 1, 1], [3, 3, 3])];
    const { hits } = detectClashes(
      geometry,
      [task({ id: "one" }), task({ id: "two", a: ["b"], b: ["a"] })],
      settings(),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].taskId).toBe("one");
  });

  it("never pairs an element with itself", () => {
    const { hits } = detectClashes(
      [box("a", [0, 0, 0], [2, 2, 2])],
      [task({ a: ["a"], b: ["a"] })],
      settings(),
    );
    expect(hits).toHaveLength(0);
  });

  it("stops at the cap and says so", () => {
    const elements = [box("a", [0, 0, 0], [2, 2, 2])];
    const others = ["b", "c", "d"].map((key, i) => box(key, [1, 1, 1 + i * 0.01], [3, 3, 3]));
    const { hits, truncated } = detectClashes(
      [...elements, ...others],
      [task({ b: ["b", "c", "d"] })],
      settings({ maxClashes: 2, checkDuplicate: false }),
    );
    expect(hits).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("copes with a large number of elements", () => {
    const grid: ClashElementGeometry[] = [];
    for (let i = 0; i < 20; i += 1) {
      for (let j = 0; j < 20; j += 1) grid.push(box(`g${i}-${j}`, [i * 2, 0, j * 2], [i * 2 + 1.5, 1, j * 2 + 1.5]));
    }
    const keys = grid.map((g) => g.key);
    const { hits } = detectClashes(grid, [task({ a: keys, b: keys })], settings());
    expect(hits).toHaveLength(0);
  });
});

describe("touching elements", () => {
  const hard = (over: Partial<ClashTask> = {}) => task({ horizontal: 0.05, vertical: 0.05, ...over });

  it("does not report a wall resting on a slab, however wide the contact is", () => {
    // A 4 m x 0.3 m wall standing on a 6 m x 6 m slab, sunk 1 micrometre into it:
    // a rounding error, but the surfaces cross all along the wall's footprint.
    const slab = box("a", [-3, 0, -3], [3, 0.2, 3]);
    const wall = box("b", [-2, 0.2 - 1e-6, -0.15], [2, 3, 0.15]);
    expect(detectClashes([slab, wall], [hard({ horizontal: 0, vertical: 0 })], settings()).hits).toHaveLength(0);
    expect(detectClashes([slab, wall], [hard()], settings()).hits).toHaveLength(0);
  });

  it("judges a real overlap by how deep it goes, not how wide it spreads", () => {
    // The same wall sunk 20 mm into the slab.
    const slab = box("a", [-3, 0, -3], [3, 0.2, 3]);
    const wall = box("b", [-2, 0.18, -0.15], [2, 3, 0.15]);

    expect(detectClashes([slab, wall], [hard({ vertical: 0.01, horizontal: 0.01 })], settings()).hits).toHaveLength(1);
    // 20 mm deep is within a 30 mm vertical tolerance, though 4 m long.
    expect(detectClashes([slab, wall], [hard({ vertical: 0.03 })], settings()).hits).toHaveLength(0);
  });

  it("applies the horizontal tolerance to a sideways overlap and the vertical one to a vertical overlap", () => {
    // Two walls end to end, overlapping 20 mm along x.
    const a = box("a", [0, 0, 0], [2, 3, 0.3]);
    const b = box("b", [1.98, 0, 0], [4, 3, 0.3]);
    expect(detectClashes([a, b], [hard({ horizontal: 0.05, vertical: 0 })], settings()).hits).toHaveLength(0);
    expect(detectClashes([a, b], [hard({ horizontal: 0.01, vertical: 1 })], settings()).hits).toHaveLength(1);
  });

  it("reports how deep a clash goes", () => {
    const a = box("a", [0, 0, 0], [2, 2, 2]);
    const b = box("b", [1.5, 0.5, 0.5], [3, 3, 3]);
    const [hit] = detectClashes([a, b], [hard({ horizontal: 0, vertical: 0 })], settings()).hits;
    expect(hit.depth).toBeCloseTo(0.5, 2);
  });
});

describe("slivers and volume", () => {
  const hard = (over: Partial<ClashTask> = {}) => task({ horizontal: 0.01, vertical: 0.01, ...over });

  /** Turn a geometry about the vertical axis through (px, pz). */
  function rotateY(g: ClashElementGeometry, degrees: number, px: number, pz: number): ClashElementGeometry {
    const a = (degrees * Math.PI) / 180;
    const out = new Float32Array(g.positions);
    for (let v = 0; v < out.length; v += 3) {
      const x = out[v] - px;
      const z = out[v + 2] - pz;
      out[v] = px + x * Math.cos(a) + z * Math.sin(a);
      out[v + 2] = pz - x * Math.sin(a) + z * Math.cos(a);
    }
    return { ...g, positions: out };
  }

  it("judges a wall joint that is slightly out of true by its deepest point, not its length", () => {
    // Wall B butts against wall A, but is turned 0.2 degrees: its end face
    // slides into A by up to ~1.7 cm at the far end, a 5 m long wedge.
    const a = box("a", [0, 0, 0], [5, 3, 0.3]);
    const b = rotateY(box("b", [0, 0, 0.3], [5, 3, 0.6]), 0.2, 0, 0.3);
    const wedge = (tolerance: number) => detectClashes([a, b], [hard({ horizontal: tolerance, vertical: tolerance })], settings()).hits;

    expect(wedge(0.03)).toHaveLength(0);
    const [hit] = wedge(0.005);
    expect(hit.kind).toBe("hard");
    expect(hit.depth).toBeGreaterThan(0.005);
    expect(hit.depth).toBeLessThan(0.03);
  });

  it("ignores an overlap below the volume tolerance, if asked to", () => {
    // 20 mm deep over 0.5 m x 0.5 m: 0.005 m3 (5 litres).
    const a = box("a", [0, 0, 0], [1, 1, 1]);
    const b = box("b", [0.98, 0.25, 0.25], [2, 0.75, 0.75]);
    const run = (over: Partial<ClashTask>) => detectClashes([a, b], [hard(over)], settings()).hits;

    expect(run({})).toHaveLength(1);
    expect(run({ useVolume: true, volume: 0.01 })).toHaveLength(0);
    expect(run({ useVolume: true, volume: 0.001 })).toHaveLength(1);
    expect(run({ useVolume: false, volume: 0.01 })).toHaveLength(1);
    expect(run({})[0].volume).toBeGreaterThan(0.003);
  });

  it("still reports a real overlap of solids, with its depth and volume", () => {
    const [hit] = detectClashes(
      [box("a", [0, 0, 0], [2, 2, 2]), box("b", [1.5, 0.5, 0.5], [3, 3, 3])],
      [hard({ horizontal: 0, vertical: 0 })],
      settings(),
    ).hits;
    expect(hit.depth).toBeCloseTo(0.5, 1);
    expect(hit.volume).toBeGreaterThan(0.5 * 1.5 * 1.5 * 0.7);
  });
});
