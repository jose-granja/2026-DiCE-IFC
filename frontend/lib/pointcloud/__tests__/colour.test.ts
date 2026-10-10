import { describe, expect, it } from "vitest";

import { availableModes, buildColours, defaultMode, percentile, rampColour } from "../colour";

const positions = new Float32Array([0, 0, 0, 0, 5, 0, 0, 10, 0]);

describe("point colouring", () => {
  it("offers only what the cloud carries, and starts with the most faithful", () => {
    expect(availableModes({ colours: null, intensities: null })).toEqual(["height", "flat"]);
    expect(availableModes({ colours: null, intensities: new Uint16Array(1) })).toEqual([
      "intensity",
      "height",
      "flat",
    ]);
    expect(defaultMode({ colours: new Uint8Array(3), intensities: new Uint16Array(1) })).toBe("rgb");
  });

  it("passes captured colour straight through", () => {
    const colours = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(buildColours("rgb", { positions, colours, intensities: null }))).toEqual(
      Array.from(colours),
    );
  });

  it("colours by height from cold at the bottom to hot at the top", () => {
    const out = buildColours("height", { positions, colours: null, intensities: null });
    const bottom = Array.from(out.subarray(0, 3));
    const top = Array.from(out.subarray(6, 9));
    expect(bottom).toEqual(rampColour(0).map(Math.round));
    expect(top[0]).toBeGreaterThan(top[2]); // red beats blue at the top
    expect(bottom[2]).toBeGreaterThan(bottom[0]); // blue beats red at the bottom
  });

  it("is not thrown by a flat cloud", () => {
    const flat = new Float32Array([0, 3, 0, 1, 3, 0]);
    expect(() => buildColours("height", { positions: flat, colours: null, intensities: null })).not.toThrow();
  });

  it("stretches intensity so one bright target does not darken the rest", () => {
    const intensities = new Uint16Array(100).fill(1000);
    intensities[0] = 65535;
    const out = buildColours("intensity", {
      positions: new Float32Array(300),
      colours: null,
      intensities,
    });
    expect(out[0]).toBe(255);
    expect(percentile(intensities, 0.98)).toBeLessThan(2000);
  });

  it("falls back to a flat colour when the requested one is not there", () => {
    const out = buildColours("rgb", { positions, colours: null, intensities: null }, [1, 2, 3]);
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 3]);
  });
});
