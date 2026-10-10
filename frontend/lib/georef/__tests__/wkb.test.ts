import { describe, expect, it } from "vitest";

import { parseWkb, unwrapGeoPackageBlob, WkbError } from "../wkb";

/**
 * Well-Known Binary, as GeoPackage stores it.
 *
 * Byte order and dimensionality are the two things that go wrong, and both go
 * wrong quietly — the geometry parses, with coordinates that are nonsense.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** A little-endian WKB point at (1, 2). */
function point(little = true): Uint8Array {
  const buffer = new ArrayBuffer(21);
  const view = new DataView(buffer);
  view.setUint8(0, little ? 1 : 0);
  view.setUint32(1, 1, little);
  view.setFloat64(5, 1, little);
  view.setFloat64(13, 2, little);
  return new Uint8Array(buffer);
}

describe("parseWkb", () => {
  it("reads a little-endian point", () => {
    expect(parseWkb(point(true)).points[0]).toEqual([1, 2, 0]);
  });

  it("reads a big-endian point, because byte order is per geometry", () => {
    // Every geometry carries its own endianness byte — including each part of
    // a multi-geometry. Reading the file's first byte and assuming it holds
    // works on most files and produces nonsense on the rest.
    expect(parseWkb(point(false)).points[0]).toEqual([1, 2, 0]);
  });

  it("reads a Z coordinate declared the ISO way", () => {
    // ISO adds 1000 to the type for Z.
    const buffer = new ArrayBuffer(29);
    const view = new DataView(buffer);
    view.setUint8(0, 1);
    view.setUint32(1, 1001, true);
    view.setFloat64(5, 1, true);
    view.setFloat64(13, 2, true);
    view.setFloat64(21, 3, true);
    expect(parseWkb(new Uint8Array(buffer)).points[0]).toEqual([1, 2, 3]);
  });

  it("reads a polygon's rings", () => {
    const ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ];
    const size = 1 + 4 + 4 + 4 + ring.length * 16;
    const view = new DataView(new ArrayBuffer(size));
    view.setUint8(0, 1);
    view.setUint32(1, 3, true);
    view.setUint32(5, 1, true);
    view.setUint32(9, ring.length, true);
    ring.forEach(([x, y], i) => {
      view.setFloat64(13 + i * 16, x, true);
      view.setFloat64(21 + i * 16, y, true);
    });

    const result = parseWkb(new Uint8Array(view.buffer));
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0][0]).toHaveLength(4);
  });

  it("refuses a type it does not know rather than inventing geometry", () => {
    expect(() => parseWkb(bytes(1, 99, 0, 0, 0))).toThrow(WkbError);
  });
});

describe("unwrapGeoPackageBlob", () => {
  it("skips the GeoPackage header to reach the WKB", () => {
    // Handing the whole blob to a WKB reader gives "unsupported geometry type
    // 18759", which is "GP" read as an integer — a genuinely confusing thing
    // to debug.
    const header = new Uint8Array(8);
    header[0] = 0x47; // G
    header[1] = 0x50; // P
    header[2] = 0;
    header[3] = 0x01; // little-endian, no envelope
    new DataView(header.buffer).setInt32(4, 3763, true);

    const blob = new Uint8Array(header.length + point().length);
    blob.set(header);
    blob.set(point(), header.length);

    const { wkb, srsId } = unwrapGeoPackageBlob(blob);
    expect(srsId).toBe(3763);
    expect(parseWkb(wkb).points[0]).toEqual([1, 2, 0]);
  });

  it("skips a declared envelope, whose size varies with the flags", () => {
    // Flags bits 1–3 give the envelope kind: 1 is xy, four doubles.
    const header = new Uint8Array(8 + 4 * 8);
    header[0] = 0x47;
    header[1] = 0x50;
    header[3] = 0x01 | (1 << 1);
    new DataView(header.buffer).setInt32(4, 3763, true);

    const blob = new Uint8Array(header.length + point().length);
    blob.set(header);
    blob.set(point(), header.length);

    expect(parseWkb(unwrapGeoPackageBlob(blob).wkb).points[0]).toEqual([1, 2, 0]);
  });

  it("refuses something that is not a GeoPackage blob", () => {
    expect(() => unwrapGeoPackageBlob(point())).toThrow(/not a GeoPackage/);
  });
});
