import { describe, expect, it } from "vitest";

import {
  compileQuantityExpression,
  findSetValue,
  matchesPropertyCondition,
  QuantityExpressionError,
} from "../quantity-query";

describe("quantity formulas", () => {
  it("combines named property and quantity values with arithmetic precedence", () => {
    const evaluate = compileQuantityExpression("area * rate + waste / 2");
    expect(evaluate({ area: 12, rate: 3, waste: 4 })).toBe(38);
  });

  it("supports parentheses, unary values and right-associative powers", () => {
    expect(compileQuantityExpression("-(2 + 3) * 2^3^1")({})).toBe(-40);
  });

  it("rejects missing inputs and division by zero", () => {
    expect(() => compileQuantityExpression("area / count")({ area: 2, count: 0 })).toThrow(
      QuantityExpressionError,
    );
    expect(() => compileQuantityExpression("area + rate")({ area: 2 })).toThrow(/rate/);
  });
});

describe("quantity property matching", () => {
  const sets = [
    {
      name: "Pset_WallCommon",
      properties: [
        { name: "LoadBearing", value: false },
        { name: "FireRating", value: "REI 60" },
        { name: "ThermalTransmittance", value: 0.24 },
      ],
    },
  ];

  it("looks up set and property names without case sensitivity", () => {
    expect(findSetValue(sets, "pset_wallcommon", "loadbearing")).toBe(false);
  });

  it("handles boolean, text and numeric conditions", () => {
    expect(matchesPropertyCondition(false, "equals", "FALSE")).toBe(true);
    expect(matchesPropertyCondition("REI 60", "contains", "rei")).toBe(true);
    expect(matchesPropertyCondition(0.24, "lessOrEqual", "0.25")).toBe(true);
  });
});
