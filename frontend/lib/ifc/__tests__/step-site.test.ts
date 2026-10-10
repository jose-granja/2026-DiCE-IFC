import { describe, expect, it } from "vitest";

import { compoundAngleToDegrees, degreesToCompoundAngle } from "../compound-angle";
import { splitStepArguments, toStepReal, writeSiteLocation } from "../step-site";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("compound angles", () => {
  it("writes degrees as degrees, minutes, seconds and millionths", () => {
    expect(degreesToCompoundAngle(51.90267650305555)).toEqual([51, 54, 9, 635411]);
    expect(degreesToCompoundAngle(0)).toEqual([0, 0, 0, 0]);
  });

  it("gives every component the sign of the angle", () => {
    expect(degreesToCompoundAngle(-8.421444)).toEqual([-8, -25, -17, -198400]);
    expect(degreesToCompoundAngle(-0.5)).toEqual([0, -30, 0, 0]);
  });

  it("carries rounding upward instead of writing 60 seconds", () => {
    expect(degreesToCompoundAngle(10 + 59 / 60 + 59.9999999 / 3600)).toEqual([11, 0, 0, 0]);
  });

  it("reads back what it wrote", () => {
    for (const value of [51.90267650305555, -8.421444, 0.000123, -179.999999, 90]) {
      expect(compoundAngleToDegrees(degreesToCompoundAngle(value))).toBeCloseTo(value, 8);
    }
  });

  it("refuses a value that is not a number", () => {
    expect(() => degreesToCompoundAngle(Number.NaN)).toThrow(RangeError);
  });
});

describe("splitStepArguments", () => {
  it("keeps lists and strings whole", () => {
    expect(splitStepArguments("'a,b',(1,2,(3,4)),$,.ELEMENT.,'it''s, ok'")).toEqual([
      "'a,b'",
      "(1,2,(3,4))",
      "$",
      ".ELEMENT.",
      "'it''s, ok'",
    ]);
  });
});

describe("writeSiteLocation", () => {
  const file = [
    "DATA;",
    "#10=IFCPERSON($,'X',$,$,$,$,$,$);",
    "#82=IFCSITE('1x3x',#18,'Schie,haven',$,$,#81,$,$,.ELEMENT.,(51,54,9,635411),(4,27,14,20143),3.5,$,$);",
    "#83=IFCWALL('g',$,$,$,$,$,$,$,$);",
    "ENDSEC;",
  ].join("\n");
  const indices = { latitude: 9, longitude: 10 };

  it("rewrites the site's latitude and longitude and nothing else", () => {
    const out = text(writeSiteLocation(bytes(file), 82, { latitude: -33.5, longitude: 18.25 }, indices)!);
    expect(out).toContain(
      "#82=IFCSITE('1x3x',#18,'Schie,haven',$,$,#81,$,$,.ELEMENT.,(-33,-30,0,0),(18,15,0,0),3.5,$,$);",
    );
    expect(out.replace(/#82=.*\n/, "")).toBe(file.replace(/#82=.*\n/, ""));
  });

  it("can change one of the two", () => {
    const out = text(writeSiteLocation(bytes(file), 82, { longitude: 5 }, indices)!);
    expect(out).toContain("(51,54,9,635411),(5,0,0,0),3.5");
  });

  it("falls back to the only site when the id has moved", () => {
    const out = text(writeSiteLocation(bytes(file), 999, { latitude: 1 }, indices)!);
    expect(out).toContain("(1,0,0,0),(4,27,14,20143)");
  });

  it("rewrites the elevation as a REAL, and only that when asked", () => {
    const out = text(writeSiteLocation(bytes(file), 82, { elevation: 190 }, { ...indices, elevation: 11 })!);
    expect(out).toContain("(51,54,9,635411),(4,27,14,20143),190.,$,$);");
    const both = text(writeSiteLocation(bytes(file), 82, { latitude: 1, elevation: -2.25 }, { ...indices, elevation: 11 })!);
    expect(both).toContain("(1,0,0,0),(4,27,14,20143),-2.25,$,$);");
  });

  it("ignores an elevation when the schema slot is unknown", () => {
    const out = text(writeSiteLocation(bytes(file), 82, { elevation: 5 }, indices)!);
    expect(out).toContain("3.5,$,$);");
  });

  it("does nothing when there is no site", () => {
    expect(writeSiteLocation(bytes("DATA;\n#1=IFCWALL($);\nENDSEC;"), 1, { latitude: 1 }, indices)).toBeNull();
  });
});

describe("toStepReal", () => {
  it("always writes a decimal point", () => {
    expect(toStepReal(190)).toBe("190.");
    expect(toStepReal(-0.5)).toBe("-0.5");
    expect(toStepReal(0)).toBe("0.");
    expect(toStepReal(1.5e-7)).toBe("1.5E-7");
    expect(toStepReal(1e21)).toBe("1.E+21");
  });
  it("refuses a value that is not a number", () => {
    expect(() => toStepReal(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
