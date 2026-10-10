import { describe, expect, it } from "vitest";

import type { GeoreferenceView } from "@/lib/ifc/types";
import {
  describeLevel,
  formatLatitude,
  formatLongitude,
  gradeGeoreferencing,
  isTrivialMapConversion,
  parseEpsgCode,
  resolveEpsgCode,
} from "../logeoref";

const FULL: GeoreferenceView = {
  hasGeoreference: true,
  source: "mapConversion",
  site: { latitude: 41.5512, longitude: -8.4214, elevation: 190 },
  context: {
    expressId: 15,
    worldCoordinateSystem: [0, 0, 0],
    trueNorth: [0, 1],
    trueNorthDegrees: 0,
  },
  mapConversion: {
    eastings: -40000,
    northings: 180000,
    orthogonalHeight: 190,
    scale: 1,
  },
  projectedCRS: { name: "EPSG:3763", description: "ETRS89 / Portugal TM06" },
  lengthUnitScale: 1,
};

function view(overrides: Partial<GeoreferenceView>): GeoreferenceView {
  return { ...FULL, ...overrides };
}

function check(report: ReturnType<typeof gradeGeoreferencing>, id: string) {
  const found = report.checks.find((c) => c.id === id);
  expect(found, `no check with id "${id}"`).toBeDefined();
  return found!;
}

describe("grading", () => {
  it("gives 50 to a fully georeferenced model", () => {
    const report = gradeGeoreferencing(FULL);
    expect(report.level).toBe(50);
    expect(report.isMappable).toBe(true);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("gives 0 to a model with nothing", () => {
    const report = gradeGeoreferencing({ hasGeoreference: false });
    expect(report.level).toBe(0);
    expect(report.isMappable).toBe(false);
  });

  it("gives 20 for latitude and longitude alone", () => {
    const report = gradeGeoreferencing({
      hasGeoreference: true,
      site: { latitude: 41.55, longitude: -8.42 },
    });
    expect(report.level).toBe(20);
    expect(check(report, "site-latlong").status).toBe("pass");
    expect(check(report, "true-north").status).toBe("fail");
    expect(check(report, "map-conversion").status).toBe("fail");
  });

  it("gives 40 when oriented but not map-converted", () => {
    const report = gradeGeoreferencing(
      view({ mapConversion: undefined, projectedCRS: undefined }),
    );
    expect(report.level).toBe(40);
    expect(report.isMappable).toBe(false);
  });

  it("reports 50 even when a lower level is missing, since they are not nested", () => {
    // A file can carry a full map conversion and no IfcSite latitude at all.
    // Grading strictly by nesting would report 0 for a model that is in fact
    // perfectly placeable.
    const report = gradeGeoreferencing(view({ site: undefined }));
    expect(report.level).toBe(50);
    expect(report.isMappable).toBe(true);
    expect(check(report, "site-latlong").status).toBe("fail");
  });

  it("is not mappable without a projected CRS", () => {
    const report = gradeGeoreferencing(view({ projectedCRS: undefined }));
    expect(report.isMappable).toBe(false);
    expect(check(report, "projected-crs").status).toBe("fail");
  });
});

describe("individual checks", () => {
  it("flags 0°/0° as a placeholder rather than a location", () => {
    const report = gradeGeoreferencing(
      view({ site: { latitude: 0, longitude: 0 } }),
    );
    const latlong = check(report, "site-latlong");
    expect(latlong.status).toBe("warn");
    expect(latlong.detail).toMatch(/placeholder/i);
  });

  it("rejects out-of-range coordinates", () => {
    const report = gradeGeoreferencing(
      view({ site: { latitude: 141.5, longitude: -8.4 } }),
    );
    expect(check(report, "site-latlong").status).toBe("fail");
  });

  it("flags a map conversion sitting at 0,0", () => {
    const report = gradeGeoreferencing(
      view({
        mapConversion: { eastings: 0, northings: 0, orthogonalHeight: 0 },
      }),
    );
    const conversion = check(report, "map-conversion");
    expect(conversion.status).toBe("warn");
    expect(report.level).not.toBe(50);
  });

  it("still flags it even with a real orthogonal height and rotation", () => {
    // Revit's placeholder — the pattern this exists to catch — leaves height
    // and rotation at their identity defaults too, but eastings/northings
    // alone (not the whole entity being zeroed) is what makes a MapConversion
    // meaningless: every real projected CRS's false origin is nowhere real.
    expect(
      isTrivialMapConversion({
        eastings: 0,
        northings: 0,
        orthogonalHeight: 190,
        xAxisAbscissa: 0.9998,
        xAxisOrdinate: 0.0175,
        scale: 1,
      }),
    ).toBe(true);
  });

  it("does not flag a real map conversion", () => {
    expect(
      isTrivialMapConversion({ eastings: -40000, northings: 180000, orthogonalHeight: 190 }),
    ).toBe(false);
  });

  it("flags a non-unit map conversion scale", () => {
    const report = gradeGeoreferencing(
      view({ mapConversion: { ...FULL.mapConversion!, scale: 0.001 } }),
    );
    const scale = check(report, "map-conversion-scale");
    expect(scale.status).toBe("warn");
    expect(scale.remedy).toMatch(/unit conversion/i);
  });

  it("does not complain about a scale of exactly 1", () => {
    const report = gradeGeoreferencing(FULL);
    expect(report.checks.some((c) => c.id === "map-conversion-scale")).toBe(false);
  });

  it("rejects a zero-length TrueNorth", () => {
    const report = gradeGeoreferencing(
      view({ context: { expressId: 1, trueNorth: [0, 0] } }),
    );
    const north = check(report, "true-north");
    expect(north.status).toBe("fail");
    expect(north.detail).toMatch(/zero-length/i);
  });

  it("warns when the CRS name is not a recognisable EPSG code", () => {
    const report = gradeGeoreferencing(
      view({ projectedCRS: { name: "our office grid" } }),
    );
    expect(check(report, "projected-crs").status).toBe("warn");
    expect(report.level).not.toBe(50);
  });

  it("carries a remedy on everything that is not a pass", () => {
    const report = gradeGeoreferencing({ hasGeoreference: false });
    for (const c of report.checks) {
      if (c.status !== "pass") {
        expect(c.remedy, `${c.id} has no remedy`).toBeTruthy();
      }
    }
  });
});

describe("parseEpsgCode", () => {
  it("reads the forms authors actually write", () => {
    expect(parseEpsgCode("EPSG:3763")).toBe(3763);
    expect(parseEpsgCode("epsg:3763")).toBe(3763);
    expect(parseEpsgCode("EPSG 3763")).toBe(3763);
    expect(parseEpsgCode("3763")).toBe(3763);
    expect(parseEpsgCode("urn:ogc:def:crs:EPSG::3763")).toBe(3763);
  });

  it("returns null rather than guessing", () => {
    expect(parseEpsgCode("ETRS89 / Portugal TM06")).toBeNull();
    expect(parseEpsgCode("our office grid")).toBeNull();
    expect(parseEpsgCode(undefined)).toBeNull();
    expect(parseEpsgCode("")).toBeNull();
  });
});

describe("resolveEpsgCode", () => {
  it("still reads an explicit code, same as parseEpsgCode", () => {
    expect(resolveEpsgCode("EPSG:3763")).toBe(3763);
  });

  it("resolves a name IFC authoring tools actually write, with no digits at all", () => {
    // The exact label this app's own registry uses for EPSG:3763 — and what
    // `parseEpsgCode` alone deliberately refuses to guess at.
    expect(resolveEpsgCode("ETRS89 / Portugal TM06")).toBe(3763);
  });

  it("resolves a short alias", () => {
    expect(resolveEpsgCode("PT-TM06")).toBe(3763);
    expect(resolveEpsgCode("Datum73")).toBe(27493);
  });

  it("does not guess when the name is genuinely unknown", () => {
    expect(resolveEpsgCode("our office grid")).toBeNull();
    expect(resolveEpsgCode(undefined)).toBeNull();
  });

  it("does not guess when a name would match more than one registry entry", () => {
    // "Hayford-Gauss" is an alias of both EPSG:27493 and EPSG:20790 — a name
    // that ambiguous must not resolve to an arbitrary one of them.
    expect(resolveEpsgCode("Hayford-Gauss")).toBeNull();
  });
});

describe("coordinate formatting", () => {
  it("formats degrees, minutes and seconds with a hemisphere", () => {
    expect(formatLatitude(41.55125)).toBe("41° 33′ 04.50″ N");
    expect(formatLongitude(-8.4214444)).toMatch(/^8° 25′ 17\.2\d″ W$/);
  });

  it("uses S and W for negatives, not a minus sign", () => {
    expect(formatLatitude(-33.85)).toContain("S");
    expect(formatLongitude(-70.66)).toContain("W");
  });
});

describe("describeLevel", () => {
  it("describes every level in the user's terms", () => {
    for (const level of [0, 20, 30, 40, 50] as const) {
      expect(describeLevel(level).length).toBeGreaterThan(10);
    }
    expect(describeLevel(50)).toMatch(/fully georeferenced/i);
  });
});
