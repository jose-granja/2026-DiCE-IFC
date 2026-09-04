import { describe, expect, it } from "vitest";

import { GeoJsonError, parseGeoJson } from "../geojson";

/**
 * GeoJSON as context geometry.
 *
 * The tests that matter are about the traps: axis order, the coordinate system
 * the format mandates, and turning a flat footprint into massing.
 */

/** ETRS89 / Portugal TM06 — what the Portuguese fixtures use. */
const EPSG = 3763;

/** A square roughly 20 m across, in Porto. */
const SQUARE: number[][] = [
  [-8.6106, 41.2882],
  [-8.6104, 41.2882],
  [-8.6104, 41.2884],
  [-8.6106, 41.2884],
  [-8.6106, 41.2882],
];

function collection(features: unknown[]) {
  return JSON.stringify({ type: "FeatureCollection", features });
}

function polygon(properties: Record<string, unknown> | null = null) {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [SQUARE] },
  };
}

describe("parseGeoJson", () => {
  it("reads longitude first, as the format requires", () => {
    // RFC 7946 §3.1.1 is [longitude, latitude]. Reversing them is the classic
    // GeoJSON bug and it is silent — the geometry renders, in the Indian Ocean.
    // Projected into PT-TM06, Porto is around x ≈ -38 000, y ≈ 165 000; the
    // swapped reading lands nowhere near.
    const result = parseGeoJson(collection([polygon()]), EPSG);

    expect(result.origin.easting).toBeGreaterThan(-60_000);
    expect(result.origin.easting).toBeLessThan(-20_000);
    expect(result.origin.northing).toBeGreaterThan(140_000);
    expect(result.origin.northing).toBeLessThan(200_000);
  });

  it("keeps a small square small", () => {
    // A projection mistake usually shows up as an absurd extent long before it
    // shows up as a wrong position.
    const result = parseGeoJson(collection([polygon()]), EPSG);
    expect(result.sizeMetres).toBeGreaterThan(5);
    expect(result.sizeMetres).toBeLessThan(60);
  });

  it("lays a footprint flat when it has no height", () => {
    const { positions } = parseGeoJson(collection([polygon()]), EPSG);
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0, 6);
    }
  });

  it("extrudes a footprint that carries a height", () => {
    // The reason to read a flat format into a 3D scene at all.
    const flat = parseGeoJson(collection([polygon()]), EPSG);
    const tall = parseGeoJson(collection([polygon({ height: 12 })]), EPSG);

    expect(tall.positions.length).toBeGreaterThan(flat.positions.length);

    const ys: number[] = [];
    for (let i = 1; i < tall.positions.length; i += 3) ys.push(tall.positions[i]);
    expect(Math.max(...ys)).toBeCloseTo(12, 3);
  });

  it("treats a storey count as an approximation, not a measurement", () => {
    // `building:levels` is a count. Three metres a storey is the figure used
    // for massing when nothing better exists.
    const { positions } = parseGeoJson(
      collection([polygon({ "building:levels": 4 })]),
      EPSG,
    );
    const ys: number[] = [];
    for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
    expect(Math.max(...ys)).toBeCloseTo(12, 3);
  });

  it("prefers an explicit height over a storey count", () => {
    const { positions } = parseGeoJson(
      collection([polygon({ height: 5, "building:levels": 40 })]),
      EPSG,
    );
    const ys: number[] = [];
    for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
    expect(Math.max(...ys)).toBeCloseTo(5, 3);
  });

  it("draws lines and points, which have no area of their own", () => {
    const lines = parseGeoJson(
      collection([
        {
          type: "Feature",
          properties: { highway: "residential" },
          geometry: { type: "LineString", coordinates: SQUARE.slice(0, 3) },
        },
      ]),
      EPSG,
    );
    expect(lines.positions.length).toBeGreaterThan(0);
    expect(lines.types[0].type).toBe("road");

    const points = parseGeoJson(
      collection([
        {
          type: "Feature",
          properties: null,
          geometry: { type: "Point", coordinates: SQUARE[0] },
        },
      ]),
      EPSG,
    );
    expect(points.positions.length).toBeGreaterThan(0);
  });

  it("accepts a bare geometry and a single feature, not only a collection", () => {
    expect(
      parseGeoJson(JSON.stringify({ type: "Polygon", coordinates: [SQUARE] }), EPSG)
        .objectCount,
    ).toBe(1);
    expect(parseGeoJson(JSON.stringify(polygon()), EPSG).objectCount).toBe(1);
  });

  it("refuses a file that declares a coordinate system it is not in", () => {
    // RFC 7946 removed `crs`; files that predate it sometimes claim a projected
    // one. Guessing a reprojection would misplace a city by hundreds of metres,
    // silently.
    const document_ = JSON.parse(collection([polygon()]));
    document_.crs = { properties: { name: "urn:ogc:def:crs:EPSG::3763" } };

    expect(() => parseGeoJson(JSON.stringify(document_), EPSG)).toThrow(
      /coordinate system/,
    );
  });

  it("accepts the CRS84 that the format does allow to be named", () => {
    const document_ = JSON.parse(collection([polygon()]));
    document_.crs = { properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } };
    expect(parseGeoJson(JSON.stringify(document_), EPSG).objectCount).toBe(1);
  });

  it("says what is wrong rather than rendering nothing", () => {
    // A named error type, so a caller can tell "bad file" from "bug".
    expect(() => parseGeoJson("not json", EPSG)).toThrow(GeoJsonError);
    expect(() => parseGeoJson("not json", EPSG)).toThrow(/not valid JSON/);
    expect(() => parseGeoJson(collection([]), EPSG)).toThrow(/no features/);
    expect(() =>
      parseGeoJson(
        collection([{ type: "Feature", properties: null, geometry: null }]),
        EPSG,
      ),
    ).toThrow(/no geometry that could be drawn/);
  });

  it("groups features by what they appear to be", () => {
    const result = parseGeoJson(
      collection([
        polygon({ building: "yes" }),
        polygon({ building: "house" }),
        polygon({ landuse: "water" }),
      ]),
      EPSG,
    );
    expect(result.types[0]).toEqual({ type: "building", count: 2 });
  });
});
