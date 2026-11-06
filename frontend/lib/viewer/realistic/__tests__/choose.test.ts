import { describe, expect, it } from "vitest";

import { chooseTexture, deltaE, meanLab, srgbToLab } from "../choose";

describe("srgbToLab", () => {
  it("matches reference values", () => {
    expect(srgbToLab([1, 1, 1])[0]).toBeCloseTo(100, 1);
    expect(srgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 5);
    const red = srgbToLab([1, 0, 0]);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 0);
    expect(red[2]).toBeCloseTo(67.2, 0);
  });
});

describe("chooseTexture", () => {
  const grey = srgbToLab([0.6, 0.6, 0.6]);
  const brown = srgbToLab([0.45, 0.3, 0.2]);

  it("picks the nearest colour", () => {
    const pick = chooseTexture(
      [
        { id: "brown", lab: brown },
        { id: "grey", lab: srgbToLab([0.62, 0.6, 0.6]) },
      ],
      grey,
      null,
    );
    expect(pick?.id).toBe("grey");
  });

  it("prefers the right kind of surface and a sound look, unless the colour is much better elsewhere", () => {
    const near = srgbToLab([0.58, 0.58, 0.58]);
    expect(chooseTexture([{ id: "floor", lab: near, surfaceUse: "floor" }, { id: "wall", lab: srgbToLab([0.66, 0.66, 0.66]), surfaceUse: "wall" }], grey, "wall")?.id).toBe("wall");
    expect(chooseTexture([{ id: "cracked", lab: near, condition: ["cracked"] }, { id: "clean", lab: srgbToLab([0.66, 0.66, 0.66]), condition: ["clean"] }], grey, null)?.id).toBe("clean");
    // A floor texture of the right colour beats a wall texture of the wrong one.
    expect(chooseTexture([{ id: "floor", lab: grey, surfaceUse: "floor" }, { id: "wall", lab: brown, surfaceUse: "wall" }], grey, "wall")?.id).toBe("floor");
  });

  it("is deterministic on ties, and null with nothing to choose from", () => {
    expect(chooseTexture([{ id: "b", lab: grey }, { id: "a", lab: grey }], grey, null)?.id).toBe("a");
    expect(chooseTexture([], grey, null)).toBeNull();
  });
});

describe("meanLab", () => {
  it("averages the middle of the image, ignoring transparent pixels", () => {
    const size = 8;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i += 1) pixels.set([200, 40, 30, 255], i * 4);
    // A transparent hole in the middle does not darken the mean.
    pixels.set([0, 0, 0, 0], (4 * size + 4) * 4);
    expect(deltaE(meanLab(pixels, size, size), srgbToLab([200 / 255, 40 / 255, 30 / 255]))).toBeLessThan(0.5);
  });
});
