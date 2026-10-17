import { ShapeUtils, Vector2 } from "three";
import { openRing } from "./context-geometry";

type Point = [number, number, number];

/**
 * Triangulate a planar 3D surface, including concavities and courtyard/window
 * holes. Project onto its dominant plane for earcut, then use the original
 * 3D vertices. An XY-only projection would collapse vertical building walls.
 */
export function polygonTriangles(rings: Point[][]): Array<[Point, Point, Point]> {
  const exterior = openRing(rings[0] ?? []);
  if (exterior.length < 3) return [];
  const holes = rings.slice(1).map(openRing).filter((ring) => ring.length >= 3);
  const origin = exterior[0];

  // Newell normal, relative to a local origin to avoid cancellation at survey
  // coordinates. Unlike the first three vertices, it tolerates collinear runs.
  const normal = [0, 0, 0];
  for (let i = 0; i < exterior.length; i++) {
    const a = exterior[i], b = exterior[(i + 1) % exterior.length];
    const ax = a[0] - origin[0], ay = a[1] - origin[1], az = a[2] - origin[2];
    const bx = b[0] - origin[0], by = b[1] - origin[1], bz = b[2] - origin[2];
    normal[0] += ay * bz - az * by;
    normal[1] += az * bx - ax * bz;
    normal[2] += ax * by - ay * bx;
  }
  const magnitude = normal.map(Math.abs);
  const axis = magnitude.indexOf(Math.max(...magnitude));
  if (!Number.isFinite(magnitude[axis]) || magnitude[axis] === 0) return [];
  // Cyclic axes preserve the sign of the normal's dominant component.
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const project = (point: Point) => new Vector2(point[u] - origin[u], point[v] - origin[v]);
  const vertices = [exterior, ...holes].flat();
  const faces = ShapeUtils.triangulateShape(exterior.map(project), holes.map((ring) => ring.map(project)));
  const triangles: Array<[Point, Point, Point]> = [];
  for (const [ia, ib, ic] of faces) {
    const a = vertices[ia], b = vertices[ib], c = vertices[ic];
    const area = (b[u] - a[u]) * (c[v] - a[v]) - (b[v] - a[v]) * (c[u] - a[u]);
    if (area === 0) continue;
    triangles.push(area * normal[axis] > 0 ? [a, b, c] : [a, c, b]);
  }
  return triangles;
}
