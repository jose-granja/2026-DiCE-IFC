"use client";

/**
 * What every context format resolves to.
 *
 * CityJSON, GeoJSON and anything added later all end up as the same thing: a
 * triangle soup in metres, relative to a projected origin, ready for
 * `renderer.setContextGeometry`. Keeping that shape in one place means the
 * viewer never learns which format a file was, and a new reader only has to
 * produce this.
 */

export type ContextGeometry = {
  /** Triangles in metres, relative to `origin`, Y-up (render convention). */
  positions: Float32Array;
  /** One RGB triple per vertex. */
  colours: Float32Array;
  /** Projected coordinates of the local origin, in `epsg`. */
  origin: { easting: number; northing: number; height: number };
  epsg: number | null;
  objectCount: number;
  /** What was read, most frequent first, so the user can see what loaded. */
  types: Array<{ type: string; count: number }>;
  /** Extent in metres, for framing. */
  sizeMetres: number;
};

/** Every context format this app can read, for the file picker and dispatch. */
export const CONTEXT_EXTENSIONS = [
  ".city.json",
  ".cityjson",
  ".geojson",
  ".json",
] as const;

/**
 * Accumulates triangles and their colours.
 *
 * Shared because getting the winding or the axis convention wrong is silent —
 * the geometry renders, just inside-out or on its side — and doing it once
 * means the readers cannot disagree.
 */
export class GeometryBuilder {
  private readonly positions: number[] = [];
  private readonly colours: number[] = [];

  /**
   * Add a triangle, converting from projected/Z-up to render/Y-up.
   *
   * Projected CRSs are easting/northing/height with Z up; the renderer is Y up
   * with −Z north. This is the same conversion the CityJSON reader and the
   * 3D-tiles frame use, and it is the one thing every reader must not
   * re-derive.
   */
  triangle(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    colour: readonly [number, number, number],
    origin: { easting: number; northing: number; height: number },
  ) {
    for (const point of [a, b, c]) {
      this.positions.push(
        point[0] - origin.easting,
        point[2] - origin.height,
        -(point[1] - origin.northing),
      );
      this.colours.push(colour[0], colour[1], colour[2]);
    }
  }

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  finish(): { positions: Float32Array; colours: Float32Array } {
    return {
      positions: new Float32Array(this.positions),
      colours: new Float32Array(this.colours),
    };
  }
}

/**
 * Fan-triangulate a closed ring of projected points.
 *
 * Correct for convex rings and acceptable for the gently non-convex footprints
 * that dominate cadastral and city data. Rings with holes are handled by the
 * caller dropping them — a hole fanned into the exterior draws a solid wedge
 * across the courtyard, and a missing courtyard is a smaller lie than an
 * invented wall.
 */
export function fanTriangles<T>(ring: T[]): Array<[T, T, T]> {
  ring = openRing(ring);

  const out: Array<[T, T, T]> = [];
  for (let i = 1; i + 1 < ring.length; i += 1) {
    out.push([ring[0], ring[i], ring[i + 1]]);
  }
  return out;
}

/**
 * Drop a ring's repeated closing point.
 *
 * Both GML and GeoJSON require a ring's last position to equal its first. Fed
 * to a triangle fan unchanged, that closing point produces one degenerate
 * triangle per ring — zero area, invisible, and quietly inflating every
 * triangle count and buffer in the scene. Cheaper to remove once here than to
 * remember in each reader.
 */
export function openRing<T>(ring: T[]): T[] {
  if (ring.length < 2) return ring;

  const first = ring[0];
  const last = ring[ring.length - 1];

  const same =
    first === last ||
    (Array.isArray(first) &&
      Array.isArray(last) &&
      first.length === last.length &&
      first.every((value, index) => value === (last as unknown[])[index]));

  return same ? ring.slice(0, -1) : ring;
}
