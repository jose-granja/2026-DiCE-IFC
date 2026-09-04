/**
 * The model's plan footprint, as WGS84 GeoJSON for the map.
 *
 * IfcEnvelopeExtractor does this properly — roof prints, wall traces, the lot.
 * This is the cheap, honest version: the convex hull of the model's vertices in
 * plan. A convex hull is never *wrong*, it is just generous around a
 * C-shaped or courtyard building, and for "is this model in the right place on
 * the map" that is the question being asked. It is labelled as a hull in the UI
 * so nobody mistakes it for a building outline.
 *
 * Pure and engine-free: it takes plan points and a placement, and returns
 * GeoJSON. The expensive part — pulling vertices out of the meshes — happens in
 * the caller, which already has them.
 */

import type { MeshView, Vec3 } from "@/lib/ifc/types";
import { localToWgs84, type Placement } from "./transform";

export type PlanPoint = [number, number];

/**
 * Convex hull by Andrew's monotone chain. O(n log n), and stable for the
 * degenerate cases a model will actually produce — a single column (one point),
 * a straight wall (collinear), an empty model.
 *
 * Returns the hull counter-clockwise, without repeating the first point.
 */
export function convexHull(points: PlanPoint[]): PlanPoint[] {
  const unique = dedupe(points);
  if (unique.length <= 2) return unique;

  const sorted = [...unique].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const lower: PlanPoint[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: PlanPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  // Both halves end where the other begins, so drop the duplicated endpoints.
  lower.pop();
  upper.pop();

  const hull = [...lower, ...upper];
  // Every point collinear: the chain collapses. Report the extremes rather than
  // an empty hull, so a single straight wall still draws something.
  return hull.length >= 3 ? hull : [sorted[0], sorted[sorted.length - 1]];
}

function cross(o: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function dedupe(points: PlanPoint[]): PlanPoint[] {
  const seen = new Set<string>();
  const out: PlanPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const key = `${point[0]}|${point[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mesh sampling
// ---------------------------------------------------------------------------

export type SampleOptions = {
  /**
   * Cap on vertices examined. A 200 MB model has tens of millions; the hull of
   * a strided sample is indistinguishable at map scale and finishes in
   * milliseconds instead of seconds.
   */
  maxVertices?: number;
};

/**
 * Plan points from the render-frame meshes, in **model coordinates**.
 *
 * The renderer is Y-up with an RTC shift applied; the map conversion is defined
 * on the file's own Z-up coordinates. So this converts back: plan x is render x,
 * plan y is −render z, and the RTC shift is undone. Getting that backwards
 * mirrors the footprint about an axis, which on a symmetric building looks
 * entirely plausible.
 */
export function planPointsFromMeshes(
  meshes: MeshView[],
  originShift: Vec3,
  lengthUnitScale: number,
  options: SampleOptions = {},
): PlanPoint[] {
  const maxVertices = options.maxVertices ?? 20_000;

  let total = 0;
  for (const mesh of meshes) total += mesh.positions.length / 3;
  if (total === 0) return [];

  const stride = Math.max(1, Math.ceil(total / maxVertices));

  const points: PlanPoint[] = [];
  let index = 0;

  for (const mesh of meshes) {
    const count = mesh.positions.length / 3;
    for (let v = 0; v < count; v += 1, index += 1) {
      if (index % stride !== 0) continue;

      // World position in the render frame: origin + local vertex.
      const rx = mesh.origin[0] + mesh.positions[v * 3];
      const rz = mesh.origin[2] + mesh.positions[v * 3 + 2];

      // Render (Y-up, RTC-shifted, metres) → IFC plan (Z-up, project units).
      const ifcX = (rx + originShift[0]) / lengthUnitScale;
      const ifcY = (-(rz + originShift[2])) / lengthUnitScale;

      points.push([ifcX, ifcY]);
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

export type FootprintFeature = {
  type: "Feature";
  properties: { kind: "model-footprint"; modelId?: string; name?: string };
  geometry: {
    type: "Polygon";
    coordinates: Array<Array<[number, number]>>;
  };
};

/**
 * Project a plan hull to WGS84 GeoJSON.
 *
 * Returns null when there is no hull to draw, rather than an empty polygon —
 * MapLibre renders an empty polygon silently, which looks like "the model is
 * somewhere else" rather than "there was nothing to draw".
 */
export function footprintToGeoJson(
  hull: PlanPoint[],
  placement: Placement,
  meta: { modelId?: string; name?: string } = {},
): FootprintFeature | null {
  if (hull.length < 3) return null;

  const ring: Array<[number, number]> = hull.map(([x, y]) => {
    const wgs = localToWgs84({ x, y, z: 0 }, placement);
    return [wgs.longitude, wgs.latitude];
  });

  // GeoJSON polygons must close explicitly; the hull does not repeat its first
  // point, and an unclosed ring is invalid rather than merely untidy.
  ring.push(ring[0]);

  return {
    type: "Feature",
    properties: { kind: "model-footprint", ...meta },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/** Bounding box of a footprint, for fitting the map. */
export function featureBounds(
  feature: FootprintFeature,
): [[number, number], [number, number]] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const [longitude, latitude] of feature.geometry.coordinates[0]) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }

  return [
    [west, south],
    [east, north],
  ];
}
