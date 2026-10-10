/**
 * Run a clash matrix over element geometry.
 *
 * Pure and worker-friendly: it is given triangles and tasks and returns hits.
 * It never reads IFC data — which elements belong to which group is decided
 * before this runs (`lib/clash/run.ts`).
 */

import {
  buildBvh,
  crossingRegion,
  isClosedMesh,
  minDistance,
  overlapProfile,
  pointInside,
  type Bvh,
} from "./geometry";
import type {
  ClashElementGeometry,
  ClashHit,
  ClashSettings,
  ClashTask,
  Vec3,
} from "./types";

/** Two corners closer than this (metres) are the same corner. */
const SAME = 1e-3;
/**
 * Overlaps shallower than this (0.1 mm) are rounding in the model or in float32,
 * not geometry, and are never reported — even with a tolerance of zero.
 */
const MIN_PENETRATION = 1e-4;
const EPS = 1e-9;

type Prepared = {
  geometry: ClashElementGeometry;
  bvh: Bvh | null;
  /** Whether the mesh is a closed solid (inside tests need that); measured on first use. */
  closed: boolean | null;
  min: Vec3;
  max: Vec3;
  centroid: Vec3;
};

export type DetectOptions = {
  onProgress?: (done: number, total: number) => void;
  /** Checked between elements; return true to stop early. */
  shouldStop?: () => boolean;
};

export function detectClashes(
  elements: ClashElementGeometry[],
  tasks: ClashTask[],
  settings: ClashSettings,
  options: DetectOptions = {},
): { hits: ClashHit[]; truncated: boolean } {
  const byKey = new Map<string, Prepared>();
  for (const geometry of elements) {
    const prepared = prepare(geometry);
    if (prepared) byKey.set(geometry.key, prepared);
  }

  const hits: ClashHit[] = [];
  const tested = new Set<string>();
  let truncated = false;

  const total = tasks.reduce((sum, task) => sum + task.a.length, 0);
  let done = 0;

  outer: for (const task of tasks) {
    const margin = task.mode === "clearance" ? task.clearance : 0;

    for (const keyA of task.a) {
      done += 1;
      if (done % 25 === 0) options.onProgress?.(done, total);
      if (options.shouldStop?.()) break outer;

      const a = byKey.get(keyA);
      if (!a) continue;

      for (const keyB of task.b) {
        if (keyA === keyB) continue;
        const b = byKey.get(keyB);
        if (!b) continue;
        if (settings.ignoreSameModel && a.geometry.modelId === b.geometry.modelId) continue;

        // A pair is one question however many matrix cells ask it.
        const pair = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
        if (tested.has(pair)) continue;

        if (!boxesOverlap(a, b, margin)) continue;
        tested.add(pair);

        const hit = testPair(task, a, b, settings);
        if (!hit) continue;
        hits.push(hit);
        if (hits.length >= settings.maxClashes) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  options.onProgress?.(total, total);
  return { hits, truncated };
}

function prepare(geometry: ClashElementGeometry): Prepared | null {
  const { positions, indices } = geometry;
  if (indices.length < 3 || positions.length < 9) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sx = 0, sy = 0, sz = 0;
  const vertices = positions.length / 3;
  for (let v = 0; v < vertices; v += 1) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
    sx += x;
    sy += y;
    sz += z;
  }
  return {
    geometry,
    bvh: null,
    closed: null,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    centroid: [sx / vertices, sy / vertices, sz / vertices],
  };
}

function isClosed(element: Prepared): boolean {
  element.closed ??= isClosedMesh(element.geometry.positions, element.geometry.indices);
  return element.closed;
}

function bvhOf(element: Prepared): Bvh {
  element.bvh ??= buildBvh(element.geometry.positions, element.geometry.indices);
  return element.bvh;
}

function boxesOverlap(a: Prepared, b: Prepared, margin: number): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a.min[axis] > b.max[axis] + margin || a.max[axis] < b.min[axis] - margin) return false;
  }
  return true;
}

function testPair(
  task: ClashTask,
  a: Prepared,
  b: Prepared,
  settings: ClashSettings,
): ClashHit | null {
  const base = { taskId: task.id, a: a.geometry.key, b: b.geometry.key };

  if (settings.checkDuplicate && isDuplicate(a, b)) {
    return {
      ...base,
      kind: "duplicate",
      distance: 0,
      depth: 0,
      extent: size(a.min, a.max),
      point: middle(a.min, a.max),
      min: a.min,
      max: a.max,
    };
  }

  const bvhA = bvhOf(a);
  const bvhB = bvhOf(b);

  const region = crossingRegion(bvhA, bvhB);
  if (region && !settings.checkOverlap && task.mode === "hard") return null;
  if (region) {
    const extent = size(region.min, region.max);
    if (task.mode === "clearance") {
      return { ...base, kind: "clearance", distance: 0, depth: 0, extent, point: middle(region.min, region.max), min: region.min, max: region.max };
    }
    includeCornersInside(region, a, b, bvhB);
    includeCornersInside(region, b, a, bvhA);
    const box = size(region.min, region.max);

    let depth: number;
    let axis: 0 | 1 | 2;
    let volume: number | undefined;
    if (isClosed(a) && isClosed(b)) {
      // Two solids: measure the overlap itself. Its bounding box is no guide —
      // a sliver along a wall joint fills a few percent of the box around it.
      const profile = overlapProfile(bvhA, bvhB, region.min, region.max);
      if (!profile.found) return null;
      depth = profile.depth;
      axis = profile.thinAxis;
      volume = profile.volume;
    } else {
      // An open mesh has no inside to measure; the box is the best there is.
      axis = box[1] <= box[0] && box[1] <= box[2] ? 1 : box[0] <= box[2] ? 0 : 2;
      depth = box[axis];
    }

    const tolerance = axis === 1 ? task.vertical : task.horizontal;
    if (depth <= Math.max(tolerance, MIN_PENETRATION) + EPS) return null;
    if (task.useVolume && volume !== undefined && volume < task.volume) return null;

    return {
      ...base,
      kind: "hard",
      distance: 0,
      depth,
      volume,
      extent: box,
      point: middle(region.min, region.max),
      min: region.min,
      max: region.max,
    };
  }

  if (settings.checkInside) {
    const inner = containedIn(a, b) ? [a, bvhB] as const : containedIn(b, a) ? [b, bvhA] as const : null;
    if (inner) {
      const [element, outerBvh] = inner;
      const p: Vec3 = [
        element.geometry.positions[0],
        element.geometry.positions[1],
        element.geometry.positions[2],
      ];
      if (pointInside(outerBvh, p)) {
        return {
          ...base,
          kind: "inside",
          distance: 0,
          depth: 0,
          extent: size(element.min, element.max),
          point: middle(element.min, element.max),
          min: element.min,
          max: element.max,
        };
      }
    }
  }

  if (task.mode === "clearance") {
    const closest = minDistance(bvhA, bvhB, task.clearance);
    if (closest && closest.distance < task.clearance - EPS) {
      const min: Vec3 = [
        Math.min(closest.pa[0], closest.pb[0]),
        Math.min(closest.pa[1], closest.pb[1]),
        Math.min(closest.pa[2], closest.pb[2]),
      ];
      const max: Vec3 = [
        Math.max(closest.pa[0], closest.pb[0]),
        Math.max(closest.pa[1], closest.pb[1]),
        Math.max(closest.pa[2], closest.pb[2]),
      ];
      return {
        ...base,
        kind: "clearance",
        distance: closest.distance,
        depth: 0,
        extent: size(min, max),
        point: middle(min, max),
        min,
        max,
      };
    }
  }

  return null;
}

/** At most this many corners of one element are tested against the other. */
const MAX_CORNER_TESTS = 20_000;

/**
 * Grow `region` to take in the corners of `element` that lie inside `other`.
 * Only corners within the two boxes' overlap can be inside, so most are
 * rejected without a ray.
 */
function includeCornersInside(
  region: { min: Vec3; max: Vec3 },
  element: Prepared,
  other: Prepared,
  otherBvh: Bvh,
) {
  const low: Vec3 = [
    Math.max(element.min[0], other.min[0]),
    Math.max(element.min[1], other.min[1]),
    Math.max(element.min[2], other.min[2]),
  ];
  const high: Vec3 = [
    Math.min(element.max[0], other.max[0]),
    Math.min(element.max[1], other.max[1]),
    Math.min(element.max[2], other.max[2]),
  ];
  const { positions } = element.geometry;
  const corners = positions.length / 3;
  const step = Math.max(1, Math.ceil(corners / MAX_CORNER_TESTS));

  for (let v = 0; v < corners; v += step) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    if (x < low[0] || x > high[0] || y < low[1] || y > high[1] || z < low[2] || z > high[2]) continue;
    if (!pointInside(otherBvh, [x, y, z])) continue;
    if (x < region.min[0]) region.min[0] = x;
    if (y < region.min[1]) region.min[1] = y;
    if (z < region.min[2]) region.min[2] = z;
    if (x > region.max[0]) region.max[0] = x;
    if (y > region.max[1]) region.max[1] = y;
    if (z > region.max[2]) region.max[2] = z;
  }
}

function isDuplicate(a: Prepared, b: Prepared): boolean {
  if (a.geometry.indices.length !== b.geometry.indices.length) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(a.min[axis] - b.min[axis]) > SAME) return false;
    if (Math.abs(a.max[axis] - b.max[axis]) > SAME) return false;
    if (Math.abs(a.centroid[axis] - b.centroid[axis]) > SAME) return false;
  }
  return true;
}

/** Is `inner`'s box within `outer`'s? */
function containedIn(inner: Prepared, outer: Prepared): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (inner.min[axis] < outer.min[axis] - EPS || inner.max[axis] > outer.max[axis] + EPS) {
      return false;
    }
  }
  return true;
}

function size(min: Vec3, max: Vec3): Vec3 {
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

function middle(min: Vec3, max: Vec3): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}
