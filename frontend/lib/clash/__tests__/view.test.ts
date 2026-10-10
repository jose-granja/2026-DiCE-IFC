import { describe, expect, it } from "vitest";

import { chooseViewDirection } from "../view";

/** A thin wall in the plane z = 0 and nothing else. */
const wall = {
  positions: new Float32Array([-5, 0, 0, 5, 0, 0, 5, 4, 0, -5, 4, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

describe("chooseViewDirection", () => {
  it("looks from the side the point of interest is on, not through the wall", () => {
    // A point just in front of the wall (z > 0) must not be viewed from behind it.
    const front = chooseViewDirection([0, 2, 0.5], 10, [wall]);
    expect(front[2]).toBeGreaterThanOrEqual(0);
    // And one behind it must not be viewed from the front.
    const back = chooseViewDirection([0, 2, -0.5], 10, [wall]);
    expect(back[2]).toBeLessThanOrEqual(0);
    // Camera positions that would put the wall in the way are never chosen.
    const camera = (d: number[]) => 0.5 + (d[2] / Math.hypot(...d)) * 10;
    expect(camera(front)).toBeGreaterThan(0);
  });

  it("always returns a direction, even with nothing in the way", () => {
    const direction = chooseViewDirection([0, 0, 0], 5, []);
    expect(Math.hypot(...direction)).toBeGreaterThan(0);
  });
});
