"use client";

/**
 * Well-Known Binary, as GeoPackage stores geometry.
 *
 * Written out rather than taken from a library because it is a small, fixed
 * format and the alternative is a dependency that also drags in projections,
 * parsers and a coordinate model this app already has its own version of.
 *
 * ## The parts that bite
 *
 * - **Byte order is per geometry, not per file.** Every geometry — including
 *   each part of a multi-geometry — carries its own endianness byte. Reading
 *   the file's first byte and assuming it holds throughout works on most files
 *   and produces nonsense on the rest.
 * - **Dimensionality is encoded in the type number**, three different ways.
 *   ISO adds 1000 for Z and 2000 for M; EWKB sets high bits instead. Both are
 *   in the wild, so both are handled.
 */

export class WkbError extends Error {}

export type WkbPoint = [number, number, number];

/** Rings of a polygon; the first is the exterior, the rest are holes. */
export type WkbPolygon = WkbPoint[][];

export type WkbGeometry = {
  polygons: WkbPolygon[];
  lines: WkbPoint[][];
  points: WkbPoint[];
};

const EWKB_Z = 0x8000_0000;
const EWKB_M = 0x4000_0000;
const EWKB_SRID = 0x2000_0000;

class Reader {
  private offset = 0;
  private little = true;

  constructor(private readonly view: DataView) {}

  byteOrder() {
    // Per geometry: nested parts may differ from their parent.
    this.little = this.view.getUint8(this.offset) === 1;
    this.offset += 1;
  }

  uint32(): number {
    const value = this.view.getUint32(this.offset, this.little);
    this.offset += 4;
    return value;
  }

  float64(): number {
    const value = this.view.getFloat64(this.offset, this.little);
    this.offset += 8;
    return value;
  }

  get done(): boolean {
    return this.offset >= this.view.byteLength;
  }
}

/** Read one WKB geometry, flattened into polygons, lines and points. */
export function parseWkb(bytes: Uint8Array): WkbGeometry {
  const out: WkbGeometry = { polygons: [], lines: [], points: [] };
  const reader = new Reader(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
  read(reader, out);
  return out;
}

function read(reader: Reader, out: WkbGeometry, depth = 0) {
  if (depth > 8) throw new WkbError("Geometry is nested too deeply to be real.");

  reader.byteOrder();
  const raw = reader.uint32();

  /*
    Two encodings, decided before anything is extracted.

    ISO puts dimensionality in the thousands — 1001 is PointZ — while EWKB sets
    high bits and keeps the type in the low byte. Masking the low byte first,
    as this did, turns ISO's 1001 into 233 and reports an unsupported type for
    a perfectly ordinary PointZ.
  */
  const isEwkb = (raw & (EWKB_Z | EWKB_M | EWKB_SRID)) !== 0;

  let type: number;
  let hasZ: boolean;
  let hasM: boolean;

  if (isEwkb) {
    type = raw & 0xff;
    hasZ = (raw & EWKB_Z) !== 0;
    hasM = (raw & EWKB_M) !== 0;
    // The SRID sits between the type and the coordinates when its flag is set.
    if ((raw & EWKB_SRID) !== 0) reader.uint32();
  } else {
    type = raw % 1000;
    // 0 xy, 1 xyz, 2 xym, 3 xyzm
    const band = Math.floor(raw / 1000);
    hasZ = band === 1 || band === 3;
    hasM = band === 2 || band === 3;
  }

  const point = (): WkbPoint => {
    const x = reader.float64();
    const y = reader.float64();
    const z = hasZ ? reader.float64() : 0;
    // M is read and discarded: it is a linear-referencing measure, not a
    // coordinate, and drawing it as one would put geometry in orbit.
    if (hasM) reader.float64();
    return [x, y, z];
  };

  const ring = (): WkbPoint[] => {
    const count = reader.uint32();
    const points: WkbPoint[] = [];
    for (let i = 0; i < count; i += 1) points.push(point());
    return points;
  };

  switch (type) {
    case 1:
      out.points.push(point());
      break;
    case 2:
      out.lines.push(ring());
      break;
    case 3: {
      const rings = reader.uint32();
      const polygon: WkbPolygon = [];
      for (let i = 0; i < rings; i += 1) polygon.push(ring());
      out.polygons.push(polygon);
      break;
    }
    case 4:
    case 5:
    case 6:
    case 7: {
      // Multi-geometries and collections: each part carries its own byte order
      // and type, so each is read as a geometry in its own right.
      const parts = reader.uint32();
      for (let i = 0; i < parts && !reader.done; i += 1) read(reader, out, depth + 1);
      break;
    }
    default:
      throw new WkbError(`Unsupported WKB geometry type ${type}.`);
  }
}

/**
 * Strip GeoPackage's own header from a geometry blob.
 *
 * A GPKG blob is `"GP"`, a version, a flags byte, an SRS id, an optional
 * envelope, and only then the WKB. Handing the whole blob to a WKB reader gives
 * "unsupported geometry type 18759" — which is `"GP"` read as a little-endian
 * integer, and a genuinely confusing thing to debug.
 *
 * Returns the WKB and the SRS the file declares for it.
 */
export function unwrapGeoPackageBlob(blob: Uint8Array): {
  wkb: Uint8Array;
  srsId: number;
} {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) {
    throw new WkbError("This is not a GeoPackage geometry blob.");
  }

  const flags = blob[3];
  const little = (flags & 0x01) === 1;
  const envelopeKind = (flags >> 1) & 0x07;

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const srsId = view.getInt32(4, little);

  // 0 none, 1 xy, 2 xyz, 3 xym, 4 xyzm — in doubles.
  const envelopeDoubles = [0, 4, 6, 6, 8][envelopeKind] ?? 0;
  const start = 8 + envelopeDoubles * 8;

  if (start >= blob.length) {
    throw new WkbError("This GeoPackage geometry blob has no geometry in it.");
  }

  return { wkb: blob.subarray(start), srsId };
}
