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

/** Linearise SQL/MM circular arcs, preserving their control points and heights. */
function circularString(points: WkbPoint[]): WkbPoint[] {
  if (points.length === 0) return [];
  if (points.length < 3 || points.length % 2 === 0) {
    throw new WkbError("A circular string needs an odd number of at least three points.");
  }
  const result: WkbPoint[] = [points[0]];
  const tau = 2 * Math.PI;
  const positive = (angle: number) => (angle % tau + tau) % tau;
  for (let i = 0; i + 2 < points.length; i += 2) {
    const [a, b, c] = points.slice(i, i + 3);
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const vx = c[0] - a[0], vy = c[1] - a[1];
    const u2 = ux * ux + uy * uy, v2 = vx * vx + vy * vy;
    const determinant = 2 * (ux * vy - uy * vx);
    const fullCircle = a[0] === c[0] && a[1] === c[1];
    if (!fullCircle && Math.abs(determinant) <= 1e-12 * Math.max(u2, v2)) {
      result.push(b, c);
      continue;
    }
    const cx = fullCircle ? (a[0] + b[0]) / 2 : a[0] + (vy * u2 - uy * v2) / determinant;
    const cy = fullCircle ? (a[1] + b[1]) / 2 : a[1] + (ux * v2 - vx * u2) / determinant;
    const radius = Math.hypot(a[0] - cx, a[1] - cy);
    const angles = [a, b, c].map((p) => Math.atan2(p[1] - cy, p[0] - cx));
    const ccw = fullCircle || positive(angles[1] - angles[0]) <= positive(angles[2] - angles[0]);
    for (let part = 0; part < 2; part++) {
      const start = [a, b][part], end = [b, c][part];
      const sweep = fullCircle ? Math.PI : ccw
        ? positive(angles[part + 1] - angles[part])
        : -positive(angles[part] - angles[part + 1]);
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
      for (let j = 1; j < steps; j++) {
        const t = j / steps, angle = angles[part] + sweep * t;
        result.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), start[2] + (end[2] - start[2]) * t]);
      }
      result.push(end);
    }
  }
  return result;
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
    case 8:
      out.lines.push(circularString(ring()));
      break;
    case 9: { // CompoundCurve: connected LineStrings and CircularStrings.
      const parts = reader.uint32();
      const curve: WkbPoint[] = [];
      for (let i = 0; i < parts; i++) {
        const child: WkbGeometry = { polygons: [], lines: [], points: [] };
        read(reader, child, depth + 1);
        if (child.polygons.length || child.points.length) throw new WkbError("Invalid compound curve member.");
        for (const line of child.lines) {
          const last = curve.at(-1);
          const shared = last && line[0]?.every((v, axis) => v === last[axis]);
          for (let j = shared ? 1 : 0; j < line.length; j++) curve.push(line[j]);
        }
      }
      out.lines.push(curve);
      break;
    }
    case 10: { // CurvePolygon: each ring is itself a WKB curve.
      const count = reader.uint32();
      const polygon: WkbPolygon = [];
      for (let i = 0; i < count; i++) {
        const child: WkbGeometry = { polygons: [], lines: [], points: [] };
        read(reader, child, depth + 1);
        if (child.lines.length !== 1 || child.polygons.length || child.points.length) {
          throw new WkbError("Invalid curve polygon ring.");
        }
        polygon.push(child.lines[0]);
      }
      out.polygons.push(polygon);
      break;
    }
    case 3:
    case 17: {
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
      for (let i = 0; i < parts; i += 1) read(reader, out, depth + 1);
      break;
    }
    case 11: // MultiCurve
    case 12: // MultiSurface
    case 15: // PolyhedralSurface
    case 16: { // TIN
      // Multi-geometries and collections: each part carries its own byte order
      // and type, so each is read as a geometry in its own right.
      const parts = reader.uint32();
      for (let i = 0; i < parts; i += 1) read(reader, out, depth + 1);
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
