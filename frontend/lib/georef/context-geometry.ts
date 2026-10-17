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

/** Source attributes stay separate from IFC entity references. */
export type ContextFeature = {
  id: string;
  name?: string;
  type: string;
  source: string;
  layer?: string;
  properties: Record<string, unknown>;
};

export type ContextFeatureRange = {
  firstTriangle: number;
  triangleCount: number;
  featureIndex: number;
};

/** Compact mapping: one range per surface, not one id per vertex. */
export class ContextFeatureIndex {
  readonly features: ContextFeature[] = [];
  readonly featureRanges: ContextFeatureRange[] = [];
  private readonly indices = new Map<ContextFeature, number>();

  add(feature: ContextFeature, firstTriangle: number, endTriangle: number) {
    if (endTriangle <= firstTriangle) return;
    let featureIndex = this.indices.get(feature);
    if (featureIndex === undefined) {
      featureIndex = this.features.length;
      this.indices.set(feature, featureIndex);
      this.features.push(feature);
    }
    const previous = this.featureRanges.at(-1);
    if (previous?.featureIndex === featureIndex && previous.firstTriangle + previous.triangleCount === firstTriangle) {
      previous.triangleCount += endTriangle - firstTriangle;
    } else {
      this.featureRanges.push({ firstTriangle, triangleCount: endTriangle - firstTriangle, featureIndex });
    }
  }
}

export function contextFeatureAt(ranges: readonly ContextFeatureRange[], triangle: number): number | null {
  if (!Number.isInteger(triangle) || triangle < 0) return null;
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (triangle < range.firstTriangle) high = middle - 1;
    else if (triangle >= range.firstTriangle + range.triangleCount) low = middle + 1;
    else return range.featureIndex;
  }
  return null;
}

export function contextFeatureName(properties: Record<string, unknown>): string | undefined {
  for (const key of ["name", "Name", "NAME", "nome", "title", "label"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value;
  }
}

export type ContextGeometry = {
  /** Triangles in metres, relative to `origin`, Y-up (render convention). */
  positions: Float32Array;
  /** One RGB triple per vertex. */
  colours: Float32Array;
  /** Per-vertex feature edge flags, prepared once in a worker after parsing. */
  edgeMasks?: Uint8Array;
  /** Local WMS image, with UVs matching the projected grid. */
  raster?: { image: ImageBitmap; uvs: Float32Array };
  attribution?: string;
  attributionUrl?: string;
  features?: ContextFeature[];
  featureRanges?: ContextFeatureRange[];
  /** Projected coordinates of the local origin, in `epsg`. */
  origin: { easting: number; northing: number; height: number };
  epsg: number | null;
  objectCount: number;
  /** Features with unreadable or unsupported geometry, reported by the loader. */
  skippedObjects?: number;
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
  ".gml",
  ".xml",
  ".citygml",
  ".gpkg",
  ".wfs",
  ".wms",
  ".context-map",
  ".context-features",
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
  private readonly featureIndex = new ContextFeatureIndex();

  addFeature(feature: ContextFeature, firstTriangle: number) {
    this.featureIndex.add(feature, firstTriangle, this.triangleCount);
  }

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

  finish() {
    return {
      positions: new Float32Array(this.positions),
      colours: new Float32Array(this.colours),
      features: this.featureIndex.features,
      featureRanges: this.featureIndex.featureRanges,
    };
  }
}

/**
 * Fan-triangulate a convex ring (for example a clipped triangle).
 * Concave surfaces and holes need polygonTriangles instead: a fan can extend
 * outside the boundary and create overlapping coplanar triangles.
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
