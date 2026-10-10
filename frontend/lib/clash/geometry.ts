/**
 * Triangle-mesh geometry for clash detection. Pure arithmetic on typed arrays —
 * no three.js, so it runs in a worker and is tested directly.
 *
 * A mesh is `positions` (xyz per vertex) and `indices` (three per triangle).
 * Every query goes through a BVH so two large elements are not compared
 * triangle against triangle.
 */

import type { Vec3 } from "./types";

// ---------------------------------------------------------------------------
// BVH
// ---------------------------------------------------------------------------

const LEAF_SIZE = 4;

export type Bvh = {
  positions: Float32Array;
  indices: Uint32Array;
  /** Triangle ids in leaf order. */
  order: Uint32Array;
  /** min xyz, max xyz per node. */
  bounds: Float32Array;
  /** Child node indices, or -1 for a leaf. */
  left: Int32Array;
  right: Int32Array;
  /** For leaves: first slot in `order` and how many triangles. */
  start: Int32Array;
  count: Int32Array;
  triangleCount: number;
};

export function buildBvh(positions: Float32Array, indices: Uint32Array): Bvh {
  const triangleCount = Math.floor(indices.length / 3);
  const order = new Uint32Array(triangleCount);
  const centroid = new Float32Array(triangleCount * 3);
  const triMin = new Float32Array(triangleCount * 3);
  const triMax = new Float32Array(triangleCount * 3);

  for (let t = 0; t < triangleCount; t += 1) {
    order[t] = t;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = positions[indices[t * 3] * 3 + axis];
      const b = positions[indices[t * 3 + 1] * 3 + axis];
      const c = positions[indices[t * 3 + 2] * 3 + axis];
      triMin[t * 3 + axis] = Math.min(a, b, c);
      triMax[t * 3 + axis] = Math.max(a, b, c);
      centroid[t * 3 + axis] = (a + b + c) / 3;
    }
  }

  const maxNodes = Math.max(1, 2 * Math.ceil(triangleCount / 1) + 1);
  const bounds = new Float32Array(maxNodes * 6);
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nodes = 0;

  const build = (from: number, to: number): number => {
    const node = nodes++;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = from; i < to; i += 1) {
      const t = order[i];
      minX = Math.min(minX, triMin[t * 3]);
      minY = Math.min(minY, triMin[t * 3 + 1]);
      minZ = Math.min(minZ, triMin[t * 3 + 2]);
      maxX = Math.max(maxX, triMax[t * 3]);
      maxY = Math.max(maxY, triMax[t * 3 + 1]);
      maxZ = Math.max(maxZ, triMax[t * 3 + 2]);
    }
    bounds.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);

    if (to - from <= LEAF_SIZE) {
      start[node] = from;
      count[node] = to - from;
      return node;
    }

    // Split the longest axis at the median centroid.
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const slice = Array.from(order.subarray(from, to));
    slice.sort((p, q) => centroid[p * 3 + axis] - centroid[q * 3 + axis]);
    order.set(slice, from);
    const mid = (from + to) >> 1;

    left[node] = build(from, mid);
    right[node] = build(mid, to);
    return node;
  };

  if (triangleCount > 0) build(0, triangleCount);

  return { positions, indices, order, bounds, left, right, start, count, triangleCount };
}

export function bvhBounds(bvh: Bvh): { min: Vec3; max: Vec3 } | null {
  if (bvh.triangleCount === 0) return null;
  const b = bvh.bounds;
  return { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] };
}

// ---------------------------------------------------------------------------
// Vectors on the stack
// ---------------------------------------------------------------------------

type Tri = [Vec3, Vec3, Vec3];

function triangleOf(bvh: Bvh, t: number, out: Tri): Tri {
  for (let k = 0; k < 3; k += 1) {
    const i = bvh.indices[t * 3 + k] * 3;
    out[k][0] = bvh.positions[i];
    out[k][1] = bvh.positions[i + 1];
    out[k][2] = bvh.positions[i + 2];
  }
  return out;
}

const makeTri = (): Tri => [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------
// Intersection
// ---------------------------------------------------------------------------

const EPS = 1e-9;
/**
 * Parameter margins. A hit exactly on a triangle's edge or diagonal still
 * counts (a box corner crossing a face's diagonal is a real crossing), so the
 * barycentric test is inclusive. What separates a crossing from a touch is the
 * segment itself: one that only *ends* on the surface, or lies in it, has no
 * interior crossing and is rejected through `t`.
 */
const BARY_SLACK = 1e-9;
const EDGE_MARGIN = 1e-7;

/**
 * Where segment `p→q` crosses triangle `tri`, or null.
 *
 * Möller–Trumbore on the segment. A segment parallel to the triangle (a face
 * lying flush against it) has no crossing, which is exactly right: touching
 * faces are not a clash.
 */
function segmentTriangle(p: Vec3, q: Vec3, tri: Tri): Vec3 | null {
  const d = sub(q, p);
  const e1 = sub(tri[1], tri[0]);
  const e2 = sub(tri[2], tri[0]);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < EPS) return null;
  const inv = 1 / det;
  const s = sub(p, tri[0]);
  const u = inv * dot(s, h);
  if (u < -BARY_SLACK || u > 1 + BARY_SLACK) return null;
  const qv = cross(s, e1);
  const v = inv * dot(d, qv);
  if (v < -BARY_SLACK || u + v > 1 + BARY_SLACK) return null;
  const t = inv * dot(e2, qv);
  if (t < EDGE_MARGIN || t > 1 - EDGE_MARGIN) return null;
  return lerp(p, q, t);
}

/**
 * Points where two triangles cross: each edge of one against the other. Empty
 * when they only touch or are coplanar.
 */
export function triangleIntersection(a: Tri, b: Tri): Vec3[] {
  const hits: Vec3[] = [];
  for (let k = 0; k < 3; k += 1) {
    const ha = segmentTriangle(a[k], a[(k + 1) % 3], b);
    if (ha) hits.push(ha);
    const hb = segmentTriangle(b[k], b[(k + 1) % 3], a);
    if (hb) hits.push(hb);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

function closestOnTriangle(p: Vec3, tri: Tri): Vec3 {
  // Ericson, Real-Time Collision Detection §5.1.5.
  const [a, b, c] = tri;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return lerp(a, b, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return lerp(a, c, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return lerp(b, c, (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

function distSq(a: Vec3, b: Vec3): number {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}

function closestSegmentSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  // Ericson §5.1.9.
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  if (a <= EPS && e <= EPS) return [p1, p2];
  if (a <= EPS) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  return [lerp(p1, q1, s), lerp(p2, q2, t)];
}

/** Closest pair of points between two triangles (not accounting for crossing). */
export function triangleDistance(a: Tri, b: Tri): { distance: number; pa: Vec3; pb: Vec3 } {
  let best = Infinity;
  let pa: Vec3 = a[0];
  let pb: Vec3 = b[0];
  const consider = (x: Vec3, y: Vec3) => {
    const d = distSq(x, y);
    if (d < best) {
      best = d;
      pa = x;
      pb = y;
    }
  };
  for (let i = 0; i < 3; i += 1) {
    consider(a[i], closestOnTriangle(a[i], b));
    const q = closestOnTriangle(b[i], a);
    consider(q, b[i]);
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const [x, y] = closestSegmentSegment(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3]);
      consider(x, y);
    }
  }
  return { distance: Math.sqrt(best), pa, pb };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function boxesOverlap(a: Float32Array, ai: number, b: Float32Array, bi: number, margin: number): boolean {
  return (
    a[ai] <= b[bi + 3] + margin &&
    a[ai + 3] >= b[bi] - margin &&
    a[ai + 1] <= b[bi + 4] + margin &&
    a[ai + 4] >= b[bi + 1] - margin &&
    a[ai + 2] <= b[bi + 5] + margin &&
    a[ai + 5] >= b[bi + 2] - margin
  );
}

function boxDistanceSq(a: Float32Array, ai: number, b: Float32Array, bi: number): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const gap = Math.max(b[bi + axis] - a[ai + 3 + axis], a[ai + axis] - b[bi + 3 + axis], 0);
    sum += gap * gap;
  }
  return sum;
}

export type CrossingRegion = {
  min: Vec3;
  max: Vec3;
  points: number;
};

/**
 * Every place the surfaces of two meshes cross, as one bounding region, or
 * null when they never do.
 */
export function crossingRegion(a: Bvh, b: Bvh): CrossingRegion | null {
  if (a.triangleCount === 0 || b.triangleCount === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let points = 0;
  const ta = makeTri();
  const tb = makeTri();

  const stack: number[] = [0, 0];
  while (stack.length > 0) {
    const nb = stack.pop()!;
    const na = stack.pop()!;
    if (!boxesOverlap(a.bounds, na * 6, b.bounds, nb * 6, 0)) continue;

    const aLeaf = a.left[na] < 0;
    const bLeaf = b.left[nb] < 0;
    if (aLeaf && bLeaf) {
      for (let i = 0; i < a.count[na]; i += 1) {
        triangleOf(a, a.order[a.start[na] + i], ta);
        for (let j = 0; j < b.count[nb]; j += 1) {
          triangleOf(b, b.order[b.start[nb] + j], tb);
          for (const hit of triangleIntersection(ta, tb)) {
            points += 1;
            for (let k = 0; k < 3; k += 1) {
              if (hit[k] < min[k]) min[k] = hit[k];
              if (hit[k] > max[k]) max[k] = hit[k];
            }
          }
        }
      }
    } else if (!aLeaf && (bLeaf || volume(a, na) >= volume(b, nb))) {
      stack.push(a.left[na], nb, a.right[na], nb);
    } else {
      stack.push(na, b.left[nb], na, b.right[nb]);
    }
  }

  return points === 0 ? null : { min, max, points };
}

function volume(bvh: Bvh, node: number): number {
  const b = bvh.bounds;
  const i = node * 6;
  return (b[i + 3] - b[i]) * (b[i + 4] - b[i + 1]) * (b[i + 5] - b[i + 2]);
}

/** Smallest gap between two meshes, with the closest points, ignoring crossings. */
export function minDistance(a: Bvh, b: Bvh, within = Infinity): { distance: number; pa: Vec3; pb: Vec3 } | null {
  if (a.triangleCount === 0 || b.triangleCount === 0) return null;
  let best = within * within;
  let result: { distance: number; pa: Vec3; pb: Vec3 } | null = null;
  const ta = makeTri();
  const tb = makeTri();

  const stack: number[] = [0, 0];
  while (stack.length > 0) {
    const nb = stack.pop()!;
    const na = stack.pop()!;
    if (boxDistanceSq(a.bounds, na * 6, b.bounds, nb * 6) >= best) continue;

    const aLeaf = a.left[na] < 0;
    const bLeaf = b.left[nb] < 0;
    if (aLeaf && bLeaf) {
      for (let i = 0; i < a.count[na]; i += 1) {
        triangleOf(a, a.order[a.start[na] + i], ta);
        for (let j = 0; j < b.count[nb]; j += 1) {
          triangleOf(b, b.order[b.start[nb] + j], tb);
          const d = triangleDistance(ta, tb);
          if (d.distance * d.distance < best) {
            best = d.distance * d.distance;
            result = d;
          }
        }
      }
    } else if (!aLeaf && (bLeaf || volume(a, na) >= volume(b, nb))) {
      stack.push(a.left[na], nb, a.right[na], nb);
    } else {
      stack.push(na, b.left[nb], na, b.right[nb]);
    }
  }
  return result;
}

/**
 * Is the point inside the (closed) mesh? Even–odd along a ray, in a direction
 * chosen to avoid axis-aligned edges and faces.
 */
export function pointInside(bvh: Bvh, p: Vec3): boolean {
  if (bvh.triangleCount === 0) return false;
  const direction: Vec3 = [0.5773, 0.3127, 0.7541];
  let crossings = 0;
  const tri = makeTri();

  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!rayHitsBox(p, direction, bvh.bounds, node * 6)) continue;
    if (bvh.left[node] < 0) {
      for (let i = 0; i < bvh.count[node]; i += 1) {
        triangleOf(bvh, bvh.order[bvh.start[node] + i], tri);
        if (rayTriangle(p, direction, tri)) crossings += 1;
      }
    } else {
      stack.push(bvh.left[node], bvh.right[node]);
    }
  }
  return crossings % 2 === 1;
}

function rayHitsBox(origin: Vec3, dir: Vec3, bounds: Float32Array, i: number): boolean {
  let tMin = 0;
  let tMax = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const inv = 1 / dir[axis];
    let t0 = (bounds[i + axis] - origin[axis]) * inv;
    let t1 = (bounds[i + 3 + axis] - origin[axis]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMax < tMin) return false;
  }
  return true;
}

function rayTriangle(origin: Vec3, dir: Vec3, tri: Tri): boolean {
  const e1 = sub(tri[1], tri[0]);
  const e2 = sub(tri[2], tri[0]);
  const h = cross(dir, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < EPS) return false;
  const inv = 1 / det;
  const s = sub(origin, tri[0]);
  const u = inv * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const v = inv * dot(dir, q);
  if (v < 0 || u + v > 1) return false;
  return inv * dot(e2, q) > EPS;
}

/**
 * How many triangles the segment `p→q` passes through, over every mesh given.
 * Used to ask "would the elements get in the way of a camera here?".
 */
export function countSegmentCrossings(
  p: Vec3,
  q: Vec3,
  meshes: Array<{ positions: Float32Array; indices: Uint32Array }>,
): number {
  let crossings = 0;
  const tri = makeTri();
  for (const mesh of meshes) {
    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k += 1) {
        const i = mesh.indices[t + k] * 3;
        tri[k][0] = mesh.positions[i];
        tri[k][1] = mesh.positions[i + 1];
        tri[k][2] = mesh.positions[i + 2];
      }
      if (segmentTriangle(p, q, tri)) crossings += 1;
    }
  }
  return crossings;
}

// ---------------------------------------------------------------------------
// Overlap measures
// ---------------------------------------------------------------------------

/** Distance from a point to the nearest triangle of the mesh. */
export function pointDistance(bvh: Bvh, p: Vec3): number {
  if (bvh.triangleCount === 0) return Infinity;
  let best = Infinity;
  const tri = makeTri();

  const nodeDistSq = (node: number): number => {
    const i = node * 6;
    let sum = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const gap = Math.max(bvh.bounds[i + axis] - p[axis], p[axis] - bvh.bounds[i + 3 + axis], 0);
      sum += gap * gap;
    }
    return sum;
  };

  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (nodeDistSq(node) >= best) continue;
    if (bvh.left[node] < 0) {
      for (let i = 0; i < bvh.count[node]; i += 1) {
        triangleOf(bvh, bvh.order[bvh.start[node] + i], tri);
        const d = distSq(p, closestOnTriangle(p, tri));
        if (d < best) best = d;
      }
    } else {
      // Nearer child last, so it is popped (and tightens `best`) first.
      const l = bvh.left[node];
      const r = bvh.right[node];
      if (nodeDistSq(l) < nodeDistSq(r)) stack.push(r, l);
      else stack.push(l, r);
    }
  }
  return Math.sqrt(best);
}

export type OverlapProfile = {
  /**
   * How deep the overlap is: twice the radius of the largest sphere that fits
   * inside both meshes — the shortest way to push one clear of the other.
   * A sliver, however long, has a tiny radius; two boxes overlapping by `d`
   * give `d`.
   */
  depth: number;
  /** Volume shared by the two meshes, cubic metres (estimated). */
  volume: number;
  /** Axis (0 x, 1 y, 2 z) along which the shared volume is thinnest. */
  thinAxis: 0 | 1 | 2;
  /** Whether any sampled point was inside both. */
  found: boolean;
};

/**
 * Measure the overlap of two *closed* meshes inside `min`…`max`, the box that
 * holds it, by sampling: a coarse grid for the volume and the thin axis, then
 * a closer look around the deepest point so a narrow ridge is not missed
 * between grid points.
 */
export function overlapProfile(a: Bvh, b: Bvh, min: Vec3, max: Vec3, grid = 8): OverlapProfile {
  const size: Vec3 = [
    Math.max(max[0] - min[0], 1e-6),
    Math.max(max[1] - min[1], 1e-6),
    Math.max(max[2] - min[2], 1e-6),
  ];
  let best = -1;
  let bestPoint: Vec3 | null = null;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let inside = 0;

  const sample = (p: Vec3, count: boolean) => {
    if (!pointInside(a, p) || !pointInside(b, p)) return;
    if (count) {
      inside += 1;
      for (let k = 0; k < 3; k += 1) {
        if (p[k] < lo[k]) lo[k] = p[k];
        if (p[k] > hi[k]) hi[k] = p[k];
      }
    }
    const radius = Math.min(pointDistance(a, p), pointDistance(b, p));
    if (radius > best) {
      best = radius;
      bestPoint = p;
    }
  };

  for (let i = 0; i < grid; i += 1) {
    for (let j = 0; j < grid; j += 1) {
      for (let k = 0; k < grid; k += 1) {
        sample(
          [
            min[0] + ((i + 0.5) / grid) * size[0],
            min[1] + ((j + 0.5) / grid) * size[1],
            min[2] + ((k + 0.5) / grid) * size[2],
          ],
          true,
        );
      }
    }
  }

  const found = bestPoint !== null;
  // Two rounds of a 5×5×5 look around the deepest point, each half as wide.
  let step: Vec3 = [size[0] / grid, size[1] / grid, size[2] / grid];
  for (let round = 0; round < 2 && bestPoint; round += 1) {
    const centre: Vec3 = bestPoint;
    for (let i = -2; i <= 2; i += 1) {
      for (let j = -2; j <= 2; j += 1) {
        for (let k = -2; k <= 2; k += 1) {
          if (i === 0 && j === 0 && k === 0) continue;
          sample(
            [centre[0] + (i * step[0]) / 2, centre[1] + (j * step[1]) / 2, centre[2] + (k * step[2]) / 2],
            false,
          );
        }
      }
    }
    step = [step[0] / 2, step[1] / 2, step[2] / 2];
  }

  const cell = (size[0] * size[1] * size[2]) / (grid * grid * grid);
  const extents: Vec3 = found
    ? [hi[0] - lo[0] + size[0] / grid, hi[1] - lo[1] + size[1] / grid, hi[2] - lo[2] + size[2] / grid]
    : size;
  const thinAxis = (extents[1] <= extents[0] && extents[1] <= extents[2] ? 1 : extents[0] <= extents[2] ? 0 : 2) as 0 | 1 | 2;

  return { depth: found ? 2 * best : 0, volume: inside * cell, thinAxis, found };
}

/**
 * Is this a solid? Inside tests only mean something for closed meshes.
 *
 * Counted by edges shared by exactly two triangles, after welding corners that
 * coincide. Not "every edge": a wall with an opening cut through it is
 * tessellated with T-junctions (a vertex on the middle of a neighbour's edge),
 * which leave a handful of odd edges in a mesh that is plainly solid. A single
 * sheet or a loose skin, by contrast, has almost none that pair up.
 */
export function isClosedMesh(positions: Float32Array, indices: Uint32Array): boolean {
  const weld = new Map<string, number>();
  const id = (v: number): number => {
    const key = `${Math.round(positions[v * 3] * 1e4)},${Math.round(positions[v * 3 + 1] * 1e4)},${Math.round(positions[v * 3 + 2] * 1e4)}`;
    let value = weld.get(key);
    if (value === undefined) {
      value = weld.size;
      weld.set(key, value);
    }
    return value;
  };
  const edges = new Map<number, number>();
  const stride = 1 << 26;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [id(indices[t]), id(indices[t + 1]), id(indices[t + 2])];
    for (let e = 0; e < 3; e += 1) {
      const a = corners[e];
      const b = corners[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * stride + b : b * stride + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let paired = 0;
  for (const count of edges.values()) if (count === 2) paired += 1;
  return edges.size > 0 && paired / edges.size >= 0.5;
}
