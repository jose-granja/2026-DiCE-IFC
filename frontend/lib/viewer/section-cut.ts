/**
 * The cross-section a section plane leaves in solid geometry, as 2D regions.
 *
 * Pure and three.js-free so the rules live where they can be tested. The
 * renderer triangulates these into the hatched fill and strokes their outlines.
 *
 * Why this exists instead of a GPU parity test: counting how many surfaces a
 * view ray crosses behind the plane fills wherever that count is odd, and an
 * open surface (a window pane, a single-sided sheet) is crossed once — so it
 * hatches empty air in front of every opening. Slicing triangles against the
 * plane only ever produces segments where geometry really intersects it, so a
 * sheet yields a line, never an area, and openings stay open.
 */

export type Vec2 = [number, number];

export type CutBatch = {
  /** xyz per vertex, in the batch's own (group-local) space. */
  positions: ArrayLike<number>;
  /** Triangle indices — the live, visibility-filtered buffer. */
  indices: ArrayLike<number>;
  /** Element id per vertex. */
  entityIds: ArrayLike<number>;
  /** Distinguishes equal element ids from different models. */
  scope: string;
  /**
   * Keep the plane's crossing of this batch as plain lines where it does not
   * close into an outline. For glazing, which is usually a single sheet: it
   * has no area to fill, but its cut should still be drawn.
   */
  keepOpen?: boolean;
};

export type CutRegion = { outer: Vec2[]; holes: Vec2[][] };

export type CutResult = {
  regions: CutRegion[];
  /** Every closed outline (outer boundaries and holes alike), for stroking. */
  loops: Vec2[][];
  /** Crossings of `keepOpen` batches that are not part of any closed outline. */
  lines: [Vec2, Vec2][];
};

/** Endpoints closer than this (metres) are the same point. */
const SNAP = 1e-4;
const MIN_AREA = 1e-8;

type Segment = { a: string; b: string };

/**
 * Slice `batches` with the plane `z = 0` of the space `m` maps their vertices
 * into (a column-major 4×4, i.e. `THREE.Matrix4.elements`). Local `x`/`y` of
 * the mapped point are the 2D coordinates reported; `z >= 0` is one side.
 */
export function cutRegions(batches: CutBatch[], m: ArrayLike<number>): CutResult {
  const points = new Map<string, Vec2>();
  const groups = new Map<string, Segment[]>();
  const keepOpen = new Set<string>();

  for (const batch of batches) {
    const { positions, indices, entityIds, scope } = batch;
    const open = batch.keepOpen === true;
    const vertexCount = positions.length / 3;
    const side = new Uint8Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const z =
        m[2] * positions[v * 3] +
        m[6] * positions[v * 3 + 1] +
        m[10] * positions[v * 3 + 2] +
        m[14];
      side[v] = z >= 0 ? 1 : 0;
    }

    const crossing = (i: number, j: number): string => {
      let ax = positions[i * 3];
      let ay = positions[i * 3 + 1];
      let az = positions[i * 3 + 2];
      let bx = positions[j * 3];
      let by = positions[j * 3 + 1];
      let bz = positions[j * 3 + 2];
      // Shared edges arrive from different triangles, often as duplicated
      // vertices, in either order. Interpolating from a canonical end gives
      // both the identical number, so their endpoints snap to one key.
      if (bx < ax || (bx === ax && (by < ay || (by === ay && bz < az)))) {
        [ax, ay, az, bx, by, bz] = [bx, by, bz, ax, ay, az];
      }
      const wa = m[2] * ax + m[6] * ay + m[10] * az + m[14];
      const wb = m[2] * bx + m[6] * by + m[10] * bz + m[14];
      const t = wa / (wa - wb);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      const u = m[0] * x + m[4] * y + m[8] * z + m[12];
      const v = m[1] * x + m[5] * y + m[9] * z + m[13];
      const key = `${Math.round(u / SNAP)},${Math.round(v / SNAP)}`;
      if (!points.has(key)) points.set(key, [u, v]);
      return key;
    };

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];
      const s0 = side[i0];
      const s1 = side[i1];
      const s2 = side[i2];
      if (s0 === s1 && s1 === s2) continue;

      // The one vertex alone on its side, and the two it is cut from.
      let lone = i0;
      let p = i1;
      let q = i2;
      if (s1 !== s0 && s1 !== s2) {
        lone = i1;
        p = i0;
        q = i2;
      } else if (s2 !== s0 && s2 !== s1) {
        lone = i2;
        p = i0;
        q = i1;
      }

      const a = crossing(lone, p);
      const b = crossing(lone, q);
      if (a === b) continue;

      const group = `${scope}:${entityIds[lone]}`;
      if (open) keepOpen.add(group);
      const list = groups.get(group);
      if (list) list.push({ a, b });
      else groups.set(group, [{ a, b }]);
    }
  }

  const regions: CutRegion[] = [];
  const allLoops: Vec2[][] = [];
  const lines: [Vec2, Vec2][] = [];

  for (const [group, segments] of groups) {
    const { loops: found, closed } = chainLoops(segments, points);
    if (keepOpen.has(group)) {
      segments.forEach((segment, index) => {
        if (!closed.has(index)) lines.push([points.get(segment.a)!, points.get(segment.b)!]);
      });
    }
    const loops = dedupe(found);
    if (loops.length === 0) continue;
    allLoops.push(...loops.map((loop) => loop.points));
    regions.push(...nest(loops));
  }

  return { regions, loops: allLoops, lines };
}

type Loop = { keys: string[]; points: Vec2[]; area: number };

/** Walk segments end to end; only chains that close back on themselves count. */
function chainLoops(
  segments: Segment[],
  points: Map<string, Vec2>,
): { loops: Loop[]; closed: Set<number> } {
  const at = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const key of [segment.a, segment.b]) {
      const list = at.get(key);
      if (list) list.push(index);
      else at.set(key, [index]);
    }
  });

  const used = new Uint8Array(segments.length);
  const loops: Loop[] = [];
  const closed = new Set<number>();

  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const walked = [s];
    const start = segments[s].a;
    const keys = [start];
    let current = segments[s].b;

    while (current !== start) {
      keys.push(current);
      const next = (at.get(current) ?? []).find((index) => !used[index]);
      if (next === undefined) break;
      used[next] = 1;
      walked.push(next);
      current = segments[next].a === current ? segments[next].b : segments[next].a;
    }

    if (current !== start || keys.length < 3) continue;
    const loopPoints = keys.map((key) => points.get(key)!);
    const area = signedArea(loopPoints);
    if (Math.abs(area) < MIN_AREA) continue;
    loops.push({ keys, points: loopPoints, area: Math.abs(area) });
    for (const index of walked) closed.add(index);
  }
  return { loops, closed };
}

/** Two solids modelled on top of each other trace the same outline twice. */
function dedupe(loops: Loop[]): Loop[] {
  const seen = new Set<string>();
  return loops.filter((loop) => {
    const signature = [...loop.keys].sort().join("|");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/**
 * Even-odd nesting within one element: a loop inside an odd number of others
 * is a hole in the nearest enclosing outline. Across elements nothing nests —
 * they are simply unioned, so a frame sitting in a wall never punches it out.
 */
function nest(loops: Loop[]): CutRegion[] {
  const parents = loops.map((loop, index) => {
    const containers: number[] = [];
    loops.forEach((other, otherIndex) => {
      if (otherIndex !== index && other.area > loop.area && inside(loop, other)) {
        containers.push(otherIndex);
      }
    });
    return containers.sort((a, b) => loops[a].area - loops[b].area);
  });

  const regions = new Map<number, CutRegion>();
  loops.forEach((loop, index) => {
    if (parents[index].length % 2 === 0) {
      regions.set(index, { outer: loop.points, holes: [] });
    }
  });
  loops.forEach((loop, index) => {
    if (parents[index].length % 2 === 1) {
      regions.get(parents[index][0])?.holes.push(loop.points);
    }
  });
  return [...regions.values()];
}

/** Is `inner` within `outer`? Decided by a vertex the two do not share. */
function inside(inner: Loop, outer: Loop): boolean {
  const shared = new Set(outer.keys);
  const index = inner.keys.findIndex((key) => !shared.has(key));
  if (index === -1) return false;
  return contains(outer.points, inner.points[index]);
}

function contains(polygon: Vec2[], [x, y]: Vec2): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      result = !result;
    }
  }
  return result;
}

function signedArea(polygon: Vec2[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return sum / 2;
}
