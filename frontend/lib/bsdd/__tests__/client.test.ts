import { describe, expect, it } from "vitest";

import { idsDataType, isUnmappedNumeric } from "../client";

/**
 * The bSDD → IDS data type mapping.
 *
 * This is a small function guarding a large failure. IDS matches a property by
 * its measure type, so a facet carrying the wrong `dataType` matches no
 * elements at all — and a specification that applies to nothing is reported as
 * a pass. Suggesting a wrong type is therefore worse than suggesting none.
 */
describe("idsDataType", () => {
  it("maps the types bSDD states unambiguously", () => {
    expect(idsDataType("String")).toBe("IFCLABEL");
    expect(idsDataType("Boolean")).toBe("IFCBOOLEAN");
    expect(idsDataType("Integer")).toBe("IFCINTEGER");
    expect(idsDataType("Time")).toBe("IFCDATETIME");
  });

  it("refuses to guess a measure for Real", () => {
    // bSDD calls 110 of IfcWall's 233 properties "Real", spanning
    // IfcThermalTransmittanceMeasure, IfcPositiveLengthMeasure and others.
    // IFCREAL is right for almost none of them, and wrong silently.
    expect(idsDataType("Real")).toBeUndefined();
    expect(isUnmappedNumeric("Real")).toBe(true);
  });

  it("returns nothing for a type it does not know", () => {
    expect(idsDataType(undefined)).toBeUndefined();
    expect(idsDataType("Complex")).toBeUndefined();
    expect(isUnmappedNumeric("String")).toBe(false);
  });
});
