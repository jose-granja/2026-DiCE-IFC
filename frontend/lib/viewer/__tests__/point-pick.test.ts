import { describe, expect, it } from "vitest";

import { buildPointIndex, pickPointOnRay } from "../point-pick";

type V = [number, number, number];
const unit = (v: V): V => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** The answer by testing every point: what the grid must agree with. */
function bruteForce(positions: Float32Array, origin: V, direction: V, tolerance: (t: number) => number) {
  let best: { index: number; t: number; offset: number } | null = null;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const v = [0, 1, 2].map((axis) => positions[i * 3 + axis] - origin[axis]);
    const t = v[0] * direction[0] + v[1] * direction[1] + v[2] * direction[2];
    if (t <= 0) continue;
    const offset = v[0] ** 2 + v[1] ** 2 + v[2] ** 2 - t * t;
    if (offset > tolerance(t) ** 2) continue;
    if (!best || t < best.t - 1e-9 || (Math.abs(t - best.t) <= 1e-9 && offset < best.offset)) {
      best = { index: i, t, offset };
    }
  }
  return best;
}

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("picking a point of a cloud", () => {
  it("takes the frontmost point under the ray, not the first in the file", () => {
    // Three points straight down the ray, listed back to front.
    const positions = new Float32Array([0, 0, 9, 0, 0, 5, 0, 0, 2]);
    const hit = pickPointOnRay(buildPointIndex(positions), [0, 0, 0], [0, 0, 1], () => 0.1);
    expect(hit?.index).toBe(2);
    expect(hit?.t).toBeCloseTo(2);
  });

  it("reaches as far from the ray as the tolerance at that distance, and no further", () => {
    const positions = new Float32Array([0.05, 0, 10]);
    const index = buildPointIndex(positions);
    expect(pickPointOnRay(index, [0, 0, 0], [0, 0, 1], () => 0.06)?.index).toBe(0);
    expect(pickPointOnRay(index, [0, 0, 0], [0, 0, 1], () => 0.04)).toBeNull();
    // The tolerance grows with distance, as pixels do in metres.
    expect(pickPointOnRay(index, [0, 0, 0], [0, 0, 1], (t) => t * 0.006)?.index).toBe(0);
  });

  it("ignores what is behind the camera", () => {
    const positions = new Float32Array([0, 0, -3]);
    expect(pickPointOnRay(buildPointIndex(positions), [0, 0, 0], [0, 0, 1], () => 1)).toBeNull();
  });

  it("skips a point the caller rejects — one a section plane has cut away — for the next", () => {
    const positions = new Float32Array([0, 0, 2, 0, 0, 5]);
    const hit = pickPointOnRay(buildPointIndex(positions), [0, 0, 0], [0, 0, 1], () => 0.1, (i) => i !== 0);
    expect(hit?.index).toBe(1);
  });

  it("works on a flat cloud — a floor scan has no height to size cells by", () => {
    const floor: number[] = [];
    for (let x = 0; x < 100; x += 1) for (let z = 0; z < 100; z += 1) floor.push(x * 0.05, 0, z * 0.05);
    const positions = new Float32Array(floor);
    const origin: V = [2, 5, 2];
    const direction = unit([0.1, -1, 0.05]);
    const tolerance = (t: number) => t * 0.004;
    expect(pickPointOnRay(buildPointIndex(positions), origin, direction, tolerance)?.index).toBe(
      bruteForce(positions, origin, direction, tolerance)?.index,
    );
  });

  it("agrees with testing every point, over many clouds and rays", () => {
    const next = random(42);
    for (let round = 0; round < 40; round += 1) {
      // A wall and a floor, like a scan, with noise.
      const points: number[] = [];
      for (let i = 0; i < 3000; i += 1) {
        const onWall = next() < 0.4;
        points.push(next() * 5, onWall ? next() * 3 : next() * 0.02, onWall ? next() * 0.02 : next() * 5);
      }
      const positions = new Float32Array(points);
      const index = buildPointIndex(positions);
      for (let ray = 0; ray < 25; ray += 1) {
        const origin: V = [next() * 12 - 3, next() * 8 + 1, next() * 12 - 3];
        const target: V = [next() * 5, next() * 3, next() * 5];
        const direction = unit([target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]]);
        const pixels = 2 + next() * 6;
        const tolerance = (t: number) => t * 0.0015 * pixels;
        const expected = bruteForce(positions, origin, direction, tolerance);
        const actual = pickPointOnRay(index, origin, direction, tolerance);
        expect(actual?.index ?? null).toBe(expected?.index ?? null);
      }
    }
  });

  it("indexes nothing and finds nothing in an empty cloud", () => {
    expect(pickPointOnRay(buildPointIndex(new Float32Array(0)), [0, 0, 0], [0, 0, 1], () => 1)).toBeNull();
  });

  it("stays quick on a large cloud", () => {
    const next = random(7);
    const count = 1_000_000;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = next() * 50;
      positions[i * 3 + 1] = next() < 0.5 ? next() * 10 : 0;
      positions[i * 3 + 2] = next() * 50;
    }
    const index = buildPointIndex(positions);
    const started = performance.now();
    for (let ray = 0; ray < 50; ray += 1) {
      const direction = unit([next() * 50 - 25 - 0, -20, next() * 50 - 25]);
      pickPointOnRay(index, [25, 20, 25], direction, (t) => t * 0.003);
    }
    // A pointer move's budget is a frame; fifty picks well inside a second
    // on any machine this runs on, where testing every point takes seconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
