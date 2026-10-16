/** Polygon tessellation and clipping in float64, before render-origin subtraction. */
import { ShapeUtils, Vector2 } from "three";
import { fanTriangles, openRing } from "./context-geometry";
import type { WkbGeometry, WkbPoint } from "./wkb";

export type ClipBox = { minX: number; minY: number; maxX: number; maxY: number };
export type ContextTriangle = [WkbPoint, WkbPoint, WkbPoint];

const finite = (p: WkbPoint) => p.every(Number.isFinite);
const inside = (p: WkbPoint, box: ClipBox) =>
  p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
const mix = (a: WkbPoint, b: WkbPoint, t: number): WkbPoint =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Sutherland–Hodgman, used only on convex triangles/ribbons, never on concave rings. */
function clipPolygon(points: WkbPoint[], box?: ClipBox): WkbPoint[] {
  if (!box) return points;
  for (const [axis, bound, sign] of [
    [0, box.minX, 1], [0, box.maxX, -1], [1, box.minY, 1], [1, box.maxY, -1],
  ] as const) {
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const aInside = (a[axis] - bound) * sign >= 0;
      const bInside = (b[axis] - bound) * sign >= 0;
      if (aInside) points.push(a);
      if (aInside !== bInside) points.push(mix(a, b, (bound - a[axis]) / (b[axis] - a[axis])));
    }
  }
  return points;
}

function clipSegment(a: WkbPoint, b: WkbPoint, box?: ClipBox): [WkbPoint, WkbPoint] | null {
  if (!box) return [a, b];
  let from = 0, to = 1;
  for (const [axis, min, max] of [[0, box.minX, box.maxX], [1, box.minY, box.maxY]] as const) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (a[axis] < min || a[axis] > max) return null;
      continue;
    }
    const t0 = (min - a[axis]) / delta, t1 = (max - a[axis]) / delta;
    from = Math.max(from, Math.min(t0, t1));
    to = Math.min(to, Math.max(t0, t1));
    if (from > to) return null;
  }
  return [mix(a, b, from), mix(a, b, to)];
}

/**
 * Triangulate in the source frame, including holes. Clip there before projecting:
 * a world-sized sea polygon must not project its faraway corners into a local CRS.
 * A second clip in the target frame makes the requested metre extent exact.
 */
export function contextTriangles(
  geometry: WkbGeometry,
  project: (point: WkbPoint) => WkbPoint,
  sourceClip?: ClipBox,
  targetClip?: ClipBox,
): ContextTriangle[] {
  const triangles: ContextTriangle[] = [];
  const add = (points: WkbPoint[]) => {
    if (!points.every(finite)) return;
    for (const triangle of fanTriangles(clipPolygon(points, targetClip))) {
      const [a, b, c] = triangle;
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-12) {
        triangles.push(triangle);
      }
    }
  };

  for (const polygon of geometry.polygons) {
    const rings = polygon.map(openRing);
    if (!rings[0] || rings[0].length < 3 || !rings.flat().every(finite)) continue;
    const vertices = rings.flat();
    const contour = rings[0].map(([x, y]) => new Vector2(x, y));
    const holes = rings.slice(1).map((ring) => ring.map(([x, y]) => new Vector2(x, y)));
    for (const indices of ShapeUtils.triangulateShape(contour, holes)) {
      add(clipPolygon(indices.map((i) => vertices[i]), sourceClip).map(project));
    }
  }

  for (const line of geometry.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (!finite(line[i]) || !finite(line[i + 1])) continue;
      const segment = clipSegment(line[i], line[i + 1], sourceClip);
      if (!segment) continue;
      const [a, b] = segment.map(project);
      if (!finite(a) || !finite(b)) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const nx = -dy / length * 0.75, ny = dx / length * 0.75;
      add([
        [a[0] + nx, a[1] + ny, a[2]], [a[0] - nx, a[1] - ny, a[2]],
        [b[0] - nx, b[1] - ny, b[2]], [b[0] + nx, b[1] + ny, b[2]],
      ]);
    }
  }
  for (const point of geometry.points) {
    if (!finite(point) || (sourceClip && !inside(point, sourceClip))) continue;
    const [x, y, z] = project(point);
    add([[x - 0.75, y - 0.75, z], [x + 0.75, y - 0.75, z], [x + 0.75, y + 0.75, z], [x - 0.75, y + 0.75, z]]);
  }
  return triangles;
}

/** Sample a clipping box boundary through an inverse CRS transform. */
export function transformClipBox(box: ClipBox, inverse: (p: WkbPoint) => WkbPoint): ClipBox {
  const points: WkbPoint[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = box.minX + (box.maxX - box.minX) * i / 16;
    const y = box.minY + (box.maxY - box.minY) * i / 16;
    points.push(inverse([x, box.minY, 0]), inverse([x, box.maxY, 0]), inverse([box.minX, y, 0]), inverse([box.maxX, y, 0]));
  }
  if (!points.every(finite)) throw new Error("Clip bounds cannot be transformed.");
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  // Pad for projection curvature between samples; the target clip removes it.
  const pad = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1e-4;
  return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
}
