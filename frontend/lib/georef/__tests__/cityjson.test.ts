import { describe, expect, it } from "vitest";

import {
  CityJsonError,
  epsgFromReferenceSystem,
  findTopLevelValue,
  parseCityJson,
  parseCityJsonClipped,
  sniffJsonType,
  topLevelEntries,
} from "../cityjson";
import { wgs84ToMap } from "../transform";

/**
 * CityJSON, read as context geometry.
 *
 * The tests that matter are the ones about the format's traps: quantised
 * vertices that look like coordinates, and boundary arrays whose nesting depth
 * depends on the geometry type.
 */

/** A minimal but real CityJSON 2.0 file: one building, one square surface. */
function file(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "CityJSON",
    version: "2.0",
    transform: { scale: [0.001, 0.001, 0.001], translate: [40000, 190000, 100] },
    metadata: {
      referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/3763",
    },
    vertices: [
      [0, 0, 0],
      [10000, 0, 0],
      [10000, 10000, 0],
      [0, 10000, 0],
    ],
    CityObjects: {
      b1: {
        type: "Building",
        geometry: [
          { type: "MultiSurface", lod: "1", boundaries: [[[0, 1, 2, 3]]] },
        ],
      },
    },
    ...overrides,
  });
}

describe("parseCityJson", () => {
  it("applies the transform rather than reading vertices raw", () => {
    // The trap: [10000, 0, 0] is not 10 km east, it is 10 m east of a
    // translate of 40 000. Skipping the transform gives numbers that look like
    // coordinates and are wrong by kilometres.
    const result = parseCityJson(file());

    expect(result.origin.easting).toBeCloseTo(40005, 3);
    expect(result.origin.northing).toBeCloseTo(190005, 3);
    // The square is 10 m across, not 10 000.
    expect(result.sizeMetres).toBeCloseTo(10, 6);
  });

  it("reads the EPSG code out of the OGC reference-system URI", () => {
    expect(parseCityJson(file()).epsg).toBe(3763);
    expect(
      epsgFromReferenceSystem("https://www.opengis.net/def/crs/EPSG/0/4326"),
    ).toBe(4326);
    expect(epsgFromReferenceSystem(undefined)).toBeNull();
    expect(epsgFromReferenceSystem("urn:ogc:def:crs:OGC::CRS84")).toBeNull();
  });

  it("converts Z-up projected coordinates to the renderer's Y-up frame", () => {
    const { positions } = parseCityJson(file());
    // Every vertex of a flat square at the minimum height sits at y = 0.
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0, 6);
    }
    // And northing became -Z: the corner 5 m north of centre is at z = -5.
    const zs = [];
    for (let i = 2; i < positions.length; i += 3) zs.push(positions[i]);
    expect(Math.min(...zs)).toBeCloseTo(-5, 6);
    expect(Math.max(...zs)).toBeCloseTo(5, 6);
  });

  it("reads a Solid, whose boundaries nest one level deeper than a MultiSurface", () => {
    // A Solid is [shell][surface][ring][index]; a MultiSurface is
    // [surface][ring][index]. Assuming one depth renders the other as noise.
    const solid = parseCityJson(
      file({
        CityObjects: {
          b1: {
            type: "Building",
            geometry: [{ type: "Solid", lod: "2", boundaries: [[[[0, 1, 2, 3]]]] }],
          },
        },
      }),
    );

    expect(solid.objectCount).toBe(1);
    // Same square, same triangle count, whatever the nesting says.
    expect(solid.positions.length).toBe(parseCityJson(file()).positions.length);
  });

  it("colours objects by type and reports what it found", () => {
    const result = parseCityJson(
      file({
        CityObjects: {
          b1: { type: "Building", geometry: [{ boundaries: [[[0, 1, 2]]] }] },
          w1: { type: "WaterBody", geometry: [{ boundaries: [[[0, 1, 3]]] }] },
          w2: { type: "WaterBody", geometry: [{ boundaries: [[[1, 2, 3]]] }] },
        },
      }),
    );

    expect(result.objectCount).toBe(3);
    expect(result.types[0]).toEqual({ type: "WaterBody", count: 2 });
  });

  it("skips a face that references a vertex which does not exist", () => {
    // Out-of-range indices appear in the wild and would read past the buffer.
    const result = parseCityJson(
      file({
        CityObjects: {
          b1: {
            type: "Building",
            geometry: [{ boundaries: [[[0, 1, 2]], [[0, 1, 99]]] }],
          },
        },
      }),
    );
    expect(result.positions.length).toBe(9);
  });

  it("refuses a file that is not CityJSON, by name", () => {
    expect(() => parseCityJson('{"type":"FeatureCollection"}')).toThrow(
      CityJsonError,
    );
    expect(() => parseCityJson("not json at all")).toThrow(/not valid JSON/);
    expect(() => parseCityJson(file({ vertices: [] }))).toThrow(/no vertices/);
  });

  it("says so when there is nothing drawable rather than rendering nothing", () => {
    expect(() =>
      parseCityJson(file({ CityObjects: { b1: { type: "Building" } } })),
    ).toThrow(/no geometry that could be drawn/);
  });
});

describe("topLevelEntries", () => {
  it("splits a flat object into its key/value pairs", () => {
    const entries = [...topLevelEntries('{"a":1,"b":"two","c":[1,2,3]}')];
    expect(entries).toEqual([
      ["a", "1"],
      ["b", '"two"'],
      ["c", "[1,2,3]"],
    ]);
  });

  it("does not split on a comma nested in an object, array or string", () => {
    const entries = [...topLevelEntries('{"a":{"x":1,"y":2},"b":"one, two","c":[1,2]}')];
    expect(entries.map(([key]) => key)).toEqual(["a", "b", "c"]);
    expect(entries[1][1]).toBe('"one, two"');
  });

  it("does not split on a comma or brace escaped inside a string", () => {
    const entries = [...topLevelEntries(String.raw`{"a":"esc \" brace }","b":2}`)];
    expect(entries).toEqual([
      ["a", String.raw`"esc \" brace }"`],
      ["b", "2"],
    ]);
  });

  it("reads the last entry correctly whether it is a scalar or a structure", () => {
    // The real-world file this reader was built for ends in a bare scalar
    // ("type":"CityJSON") — the case a naive "value ends at the next comma
    // or brace" scan gets wrong, because the object's own closing brace also
    // matches "brace".
    expect([...topLevelEntries('{"a":1,"b":"last"}')]).toEqual([
      ["a", "1"],
      ["b", '"last"'],
    ]);
    expect([...topLevelEntries('{"a":1,"b":{"x":1}}')]).toEqual([
      ["a", "1"],
      ["b", '{"x":1}'],
    ]);
  });

  it("tolerates trailing whitespace or a CRLF after the closing brace", () => {
    expect([...topLevelEntries('{"a":1}\r\n')]).toEqual([["a", "1"]]);
  });

  it("yields nothing for text with no top-level object", () => {
    expect([...topLevelEntries("not json at all")]).toEqual([]);
    expect([...topLevelEntries("[1,2,3]")]).toEqual([]);
  });
});

describe("findTopLevelValue / sniffJsonType", () => {
  it("finds a key regardless of where it sits among huge neighbours", () => {
    // Mirrors the real file: a multi-megabyte "CityObjects" before the small
    // "type" — sniffing must not depend on key order.
    const bigNeighbour = `"CityObjects":{"a":${JSON.stringify({ x: "y".repeat(1000) })}}`;
    const text = `{${bigNeighbour},"type":"CityJSON","version":"1.0.1"}`;

    expect(sniffJsonType(text)).toBe("CityJSON");
    expect(findTopLevelValue(text, "version")).toBe('"1.0.1"');
  });

  it("returns undefined rather than throwing when there is no such key", () => {
    expect(sniffJsonType('{"a":1}')).toBeUndefined();
    expect(sniffJsonType("not json at all")).toBeUndefined();
  });
});

describe("parseCityJsonClipped", () => {
  /** Two buildings: one square near REF, one far away. */
  function geographicFile(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: "CityJSON",
      version: "1.1",
      metadata: { referenceSystem: "EPSG:4326" },
      vertices: [
        [-8.6077, 41.132, 0],
        [-8.6076, 41.132, 0],
        [-8.6076, 41.1321, 0],
        [-8.6077, 41.1321, 0],
        // ~5 km away — well outside any reasonable radius.
        [-8.7, 41.2, 0],
        [-8.6999, 41.2, 0],
        [-8.6999, 41.2001, 0],
        [-8.7, 41.2001, 0],
      ],
      CityObjects: {
        near: { type: "Building", geometry: [{ boundaries: [[[0, 1, 2, 3]]] }] },
        far: { type: "Building", geometry: [{ boundaries: [[[4, 5, 6, 7]]] }] },
      },
      ...overrides,
    });
  }

  const REF = { referenceLongitude: -8.60765, referenceLatitude: 41.13205 };

  it("keeps only the objects within the radius", () => {
    const result = parseCityJsonClipped(geographicFile(), {
      ...REF,
      radiusMetres: 100,
      targetEpsg: 3763,
    });

    expect(result.objectCount).toBe(1);
    expect(result.types).toEqual([{ type: "Building", count: 1 }]);
  });

  it("reprojects geographic vertices into the target CRS", () => {
    const result = parseCityJsonClipped(geographicFile(), {
      ...REF,
      radiusMetres: 100,
      targetEpsg: 3763,
    });

    const expectedCentre = wgs84ToMap({ longitude: -8.60765, latitude: 41.1320 }, 3763);
    // The kept square's centre should land near the same map point its
    // corners project to individually — not at the raw, unprojected degree
    // values (which would be off by six orders of magnitude).
    expect(result.origin.easting).toBeCloseTo(expectedCentre.easting, 0);
    expect(result.epsg).toBe(3763);
  });

  it("skips reprojection when the file is already in the target CRS", () => {
    const centre = wgs84ToMap({ longitude: -8.60765, latitude: 41.13205 }, 3763);
    const projectedFile = JSON.stringify({
      type: "CityJSON",
      version: "1.1",
      metadata: { referenceSystem: "EPSG:3763" },
      vertices: [
        [centre.easting - 5, centre.northing - 5, 0],
        [centre.easting + 5, centre.northing - 5, 0],
        [centre.easting + 5, centre.northing + 5, 0],
        [centre.easting - 5, centre.northing + 5, 0],
      ],
      CityObjects: {
        b1: { type: "Building", geometry: [{ boundaries: [[[0, 1, 2, 3]]] }] },
      },
    });

    const result = parseCityJsonClipped(projectedFile, {
      ...REF,
      radiusMetres: 100,
      targetEpsg: 3763,
    });

    expect(result.objectCount).toBe(1);
    expect(result.sizeMetres).toBeCloseTo(10, 6);
  });

  it("throws when nothing falls within the radius", () => {
    expect(() =>
      parseCityJsonClipped(geographicFile(), { ...REF, radiusMetres: 1, targetEpsg: 3763 }),
    ).toThrow(/No CityJSON objects/);
  });

  it("throws when the file declares no usable reference system", () => {
    expect(() =>
      parseCityJsonClipped(geographicFile({ metadata: {} }), {
        ...REF,
        radiusMetres: 100,
        targetEpsg: 3763,
      }),
    ).toThrow(/no usable reference system/);
  });
});
