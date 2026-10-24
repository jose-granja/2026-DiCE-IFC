import { describe, expect, it } from "vitest";
import { formatPropertyValue as format } from "../property-format";

describe("property display precision", () => {
  it("rounds only numeric values with units, to three decimal places by default", () => {
    expect(format(12.3456789, "Yes", "No", "m²")).toBe("12.346 m²");
    expect(format("12.3456789", "Yes", "No", "m")).toBe("12.346 m");
    expect(format(12.3456789, "Yes", "No")).toBe("12.3456789");
    expect(format("001.23456789", "Yes", "No")).toBe("001.23456789");
    expect(format(12.3456789, "Yes", "No", "")).toBe("12.3456789");
    expect(format(12.3456789, "Yes", "No", " ")).toBe("12.3456789");
  });

  it("supports zero and custom precision, decimal ties, and negative values without negative zero", () => {
    expect(format(1.005, "Yes", "No", "m", 2)).toBe("1.01 m");
    expect(format(-1.005, "Yes", "No", "m", 2)).toBe("-1.01 m");
    expect(format(1.23456789, "Yes", "No", "m", 5)).toBe("1.23457 m");
    expect(format(1.5, "Yes", "No", "m", 0)).toBe("2 m");
    expect(format(-0.00001, "Yes", "No", "m")).toBe("0 m");
    expect(format(0, "Yes", "No", "m")).toBe("0 m");
    expect(format(1e-7, "Yes", "No", "m", 8)).toBe("0.0000001 m");
  });

  it("keeps missing, boolean and nonnumeric text values intact", () => {
    expect(format(null, "Yes", "No", "m")).toBe("");
    expect(format("", "Yes", "No", "m")).toBe("");
    expect(format(false, "Sim", "Não", "m")).toBe("Não");
    expect(format("REI 60", "Yes", "No", "m")).toBe("REI 60");
    expect(format(12.3456789, "Yes", "No", "m", Infinity)).toBe("12.346 m");
  });
});
