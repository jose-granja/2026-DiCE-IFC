import { describe, expect, it } from "vitest";

import { effectiveScale } from "../scale";

describe("effectiveScale — how big a model is drawn, given IfcMapConversion.Scale", () => {
  it("is the number as written for a metre project, grid factors included", () => {
    expect(effectiveScale(1, 1)).toBe(1);
    expect(effectiveScale(0.9996, 1)).toBe(0.9996);
    expect(effectiveScale(undefined, 1)).toBe(1);
  });

  it("does not shrink a millimetre model whose Scale is the unit conversion", () => {
    // The engine already converted mm to metres; applying 0.001 again made the
    // model a thousandth of its size.
    expect(effectiveScale(0.001, 0.001)).toBeCloseTo(1, 12);
  });

  it("recognises the other usual conversions", () => {
    expect(effectiveScale(0.3048, 0.3048)).toBeCloseTo(1, 12); // feet
    expect(effectiveScale(0.0254, 0.0254)).toBeCloseTo(1, 12); // inches
    expect(effectiveScale(0.01, 0.01)).toBeCloseTo(1, 12); // centimetres
  });

  it("keeps a unit conversion that also carries a grid factor", () => {
    expect(effectiveScale(0.0010002, 0.001)).toBeCloseTo(1.0002, 9);
  });

  it("leaves a millimetre project with Scale 1 at true size, not a thousand times larger", () => {
    expect(effectiveScale(1, 0.001)).toBe(1);
  });

  it("keeps a real grid factor on a millimetre project", () => {
    expect(effectiveScale(0.9996, 0.001)).toBe(0.9996);
  });

  it("falls back to 1 for nonsense rather than hiding or exploding the model", () => {
    expect(effectiveScale(0, 1)).toBe(1);
    expect(effectiveScale(-2, 0.001)).toBe(1);
    expect(effectiveScale(Number.NaN, 1)).toBe(1);
  });
});
