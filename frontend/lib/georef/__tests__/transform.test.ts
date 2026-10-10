import { describe, expect, it } from "vitest";

import {
  findCrs,
  groupCrsByRegion,
  isWithinBounds,
  searchCrs,
} from "@/config/epsg";
import {
  UnknownCrsError,
  gridConvergence,
  gridRotation,
  isSupportedCrs,
  localToMap,
  localToWgs84,
  mapToLocal,
  mapToWgs84,
  placementFromSite,
  rotationFromDegrees,
  wgs84ToLocal,
  wgs84ToMap,
  type Placement,
} from "../transform";

/** Braga, in ETRS89 / PT-TM06 — the app's default CRS. */
const BRAGA = { longitude: -8.4214444, latitude: 41.55125 };

const PLACEMENT: Placement = {
  epsg: 3763,
  lengthUnitScale: 1,
  conversion: {
    eastings: -40000,
    northings: 180000,
    orthogonalHeight: 190,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
  },
};

describe("registry", () => {
  it("finds Portuguese systems by code, alias and name", () => {
    expect(findCrs(3763)?.label).toMatch(/Portugal TM06/);
    expect(searchCrs("TM06").map((c) => c.code)).toContain(3763);
    expect(searchCrs("3763").map((c) => c.code)).toContain(3763);
    expect(searchCrs("madeira").map((c) => c.code)).toContain(5015);
  });

  it("puts mainland Portugal first, because that is what gets picked", () => {
    expect(groupCrsByRegion()[0].region).toBe("Portugal (mainland)");
    expect(searchCrs("")[0].code).toBe(3763);
  });

  it("returns null for an unknown code rather than a wrong one", () => {
    expect(findCrs(99999)).toBeNull();
    expect(isSupportedCrs(99999)).toBe(false);
    expect(isSupportedCrs(3763)).toBe(true);
  });

  it("knows whether a position is inside a CRS's area of use", () => {
    const pt = findCrs(3763)!;
    expect(isWithinBounds(pt, BRAGA.longitude, BRAGA.latitude)).toBe(true);
    // Madeira is well outside the mainland grid.
    expect(isWithinBounds(pt, -16.9, 32.65)).toBe(false);
  });
});

describe("map ↔ WGS84", () => {
  it("round-trips a Portuguese position through PT-TM06", () => {
    const map = wgs84ToMap(BRAGA, 3763);
    const back = mapToWgs84(map, 3763);

    expect(back.longitude).toBeCloseTo(BRAGA.longitude, 9);
    expect(back.latitude).toBeCloseTo(BRAGA.latitude, 9);
  });

  it("places Braga where PT-TM06 says it is", () => {
    const map = wgs84ToMap(BRAGA, 3763);
    // PT-TM06's origin is near Melriça; Braga is ~24 km west and ~210 km north.
    expect(map.easting).toBeGreaterThan(-40_000);
    expect(map.easting).toBeLessThan(-15_000);
    expect(map.northing).toBeGreaterThan(190_000);
    expect(map.northing).toBeLessThan(220_000);
  });

  it("round-trips through Madeira's UTM zone too", () => {
    const funchal = { longitude: -16.9241, latitude: 32.6669 };
    const back = mapToWgs84(wgs84ToMap(funchal, 5015), 5015);
    expect(back.longitude).toBeCloseTo(funchal.longitude, 9);
    expect(back.latitude).toBeCloseTo(funchal.latitude, 9);
  });

  it("throws a named error for a CRS that is not bundled", () => {
    expect(() => wgs84ToMap(BRAGA, 99999)).toThrow(UnknownCrsError);
    expect(() => wgs84ToMap(BRAGA, 99999)).toThrow(/config\/epsg\.ts/);
  });
});

describe("gridConvergence", () => {
  it("is ~0 on the CRS's own central meridian", () => {
    // PT-TM06's central meridian is -8.1331083°; a point on it has grid
    // north and true north pointing the same way regardless of northing.
    const onMeridian = wgs84ToMap(
      { longitude: -8.13310833333333, latitude: 40 },
      3763,
    );
    expect(gridConvergence(onMeridian, 3763)).toBeCloseTo(0, 3);
  });

  it("is non-zero, and grows with distance from the meridian", () => {
    // A real site from a georeferenced fixture, ~40 km west of PT-TM06's
    // central meridian. Regression pin: this is the magnitude (~0.31°) that
    // motivated the correction — small enough to look like "the position is
    // slightly off" rather than an obviously broken rotation.
    const nearMeridian = { easting: -5_000, northing: 100_000 };
    const farFromMeridian = { easting: -40_000, northing: 160_000 };

    const near = Math.abs(gridConvergence(nearMeridian, 3763));
    const far = Math.abs(gridConvergence(farFromMeridian, 3763));

    expect(far).toBeGreaterThan(near);
    expect((far * 180) / Math.PI).toBeCloseTo(0.31, 1);
  });

  it("flips sign on the other side of the meridian", () => {
    const west = gridConvergence({ easting: -40_000, northing: 160_000 }, 3763);
    const east = gridConvergence({ easting: 40_000, northing: 160_000 }, 3763);
    expect(Math.sign(west)).not.toBe(Math.sign(east));
  });
});

describe("model ↔ map", () => {
  it("translates the origin to the map conversion's position", () => {
    const map = localToMap({ x: 0, y: 0, z: 0 }, PLACEMENT);
    expect(map.easting).toBeCloseTo(-40000, 9);
    expect(map.northing).toBeCloseTo(180000, 9);
    expect(map.height).toBeCloseTo(190, 9);
  });

  it("keeps model axes aligned to map axes with no rotation", () => {
    const map = localToMap({ x: 100, y: 50, z: 5 }, PLACEMENT);
    expect(map.easting).toBeCloseTo(-40000 + 100, 9);
    expect(map.northing).toBeCloseTo(180000 + 50, 9);
    expect(map.height).toBeCloseTo(195, 9);
  });

  it("applies the grid rotation", () => {
    // 90°: the model's +x points along map north.
    const rotated: Placement = {
      ...PLACEMENT,
      conversion: {
        ...PLACEMENT.conversion,
        xAxisAbscissa: 0,
        xAxisOrdinate: 1,
      },
    };
    const map = localToMap({ x: 100, y: 0 }, rotated);
    expect(map.easting).toBeCloseTo(-40000, 6);
    expect(map.northing).toBeCloseTo(180000 + 100, 6);
  });

  it("converts project units — a millimetre model is not 1000× too far out", () => {
    const millimetres: Placement = { ...PLACEMENT, lengthUnitScale: 0.001 };
    const map = localToMap({ x: 100_000, y: 0 }, millimetres);
    // 100 000 mm is 100 m, not 100 km.
    expect(map.easting).toBeCloseTo(-40000 + 100, 9);
  });

  it("applies the map conversion scale", () => {
    const scaled: Placement = {
      ...PLACEMENT,
      conversion: { ...PLACEMENT.conversion, scale: 2 },
    };
    expect(localToMap({ x: 100, y: 0 }, scaled).easting).toBeCloseTo(
      -40000 + 200,
      9,
    );
  });

  it("round-trips through the inverse, rotation and units included", () => {
    const awkward: Placement = {
      epsg: 3763,
      lengthUnitScale: 0.001,
      conversion: {
        eastings: -37500.5,
        northings: 195000.25,
        orthogonalHeight: 25,
        xAxisAbscissa: Math.cos(Math.PI / 7),
        xAxisOrdinate: Math.sin(Math.PI / 7),
        scale: 1,
      },
    };

    const original = { x: 12_345, y: -6_789, z: 3_210 };
    const back = mapToLocal(localToMap(original, awkward), awkward);

    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
    expect(back.z!).toBeCloseTo(original.z, 6);
  });

  it("inverts the rotation by transposing, not by flipping one sign", () => {
    // A sign flip happens to be right at 0° and 180°, so the check uses an
    // angle where the two differ.
    const rotated: Placement = {
      ...PLACEMENT,
      conversion: {
        ...PLACEMENT.conversion,
        xAxisAbscissa: Math.cos(Math.PI / 3),
        xAxisOrdinate: Math.sin(Math.PI / 3),
      },
    };
    const point = { x: 40, y: 90, z: 0 };
    const back = mapToLocal(localToMap(point, rotated), rotated);
    expect(back.x).toBeCloseTo(40, 9);
    expect(back.y).toBeCloseTo(90, 9);
  });
});

describe("grid rotation", () => {
  it("normalises a non-unit direction", () => {
    const { cos, sin, degrees } = gridRotation({
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 2,
      xAxisOrdinate: 0,
    });
    expect(cos).toBeCloseTo(1, 9);
    expect(sin).toBeCloseTo(0, 9);
    expect(degrees).toBeCloseTo(0, 9);
  });

  it("falls back to no rotation for a zero-length direction", () => {
    const { cos, sin } = gridRotation({
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 0,
      xAxisOrdinate: 0,
    });
    expect(cos).toBe(1);
    expect(sin).toBe(0);
  });

  it("defaults to no rotation when the axis is absent", () => {
    expect(
      gridRotation({ eastings: 0, northings: 0, orthogonalHeight: 0 }).degrees,
    ).toBe(0);
  });

  it("builds a rotation pair from degrees without float noise", () => {
    const { xAxisAbscissa, xAxisOrdinate } = rotationFromDegrees(90);
    expect(xAxisAbscissa).toBe(0);
    expect(xAxisOrdinate).toBe(1);
    expect(gridRotation({
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa,
      xAxisOrdinate,
    }).degrees).toBeCloseTo(90, 9);
  });
});

describe("model ↔ WGS84", () => {
  it("round-trips the model origin", () => {
    const wgs = localToWgs84({ x: 0, y: 0, z: 0 }, PLACEMENT);
    const back = wgs84ToLocal(wgs, PLACEMENT);
    expect(back.x).toBeCloseTo(0, 6);
    expect(back.y).toBeCloseTo(0, 6);
  });

  it("puts a model with the fixture's map conversion in Portugal", () => {
    const wgs = localToWgs84({ x: 0, y: 0 }, PLACEMENT);
    expect(wgs.longitude).toBeGreaterThan(-9.6);
    expect(wgs.longitude).toBeLessThan(-6.1);
    expect(wgs.latitude).toBeGreaterThan(36.9);
    expect(wgs.latitude).toBeLessThan(42.2);
  });
});

describe("placementFromSite", () => {
  it("puts the model origin at the site coordinates, unrotated", () => {
    const placement = placementFromSite(
      { ...BRAGA, elevation: 190 },
      3763,
      1,
    );

    const wgs = localToWgs84({ x: 0, y: 0 }, placement);
    expect(wgs.longitude).toBeCloseTo(BRAGA.longitude, 6);
    expect(wgs.latitude).toBeCloseTo(BRAGA.latitude, 6);

    // Orientation is a guess here, so it must be the identity rather than
    // something invented.
    expect(placement.conversion.xAxisAbscissa).toBe(1);
    expect(placement.conversion.xAxisOrdinate).toBe(0);
    expect(placement.conversion.scale).toBe(1);
  });

  it("converts the site elevation into map units", () => {
    const placement = placementFromSite(
      { ...BRAGA, elevation: 190_000 },
      3763,
      0.001,
    );
    expect(placement.conversion.orthogonalHeight).toBeCloseTo(190, 6);
  });
});
