/**
 * Picking a point of a point cloud under the cursor, for measuring on a scan.
 *
 * three's raycaster tests every point of a `Points` object in JavaScript. The
 * measuring tools pick on every pointer move (that is how the snap preview
 * follows the cursor), and a cloud can hold eight million points, so a linear
 * test would stall the viewport on each move. Instead each cloud gets a uniform
 * grid, built once — the first time it is picked — and a pick walks the ray
 * through it front to back, testing only the points in the cells it passes and
 * stopping once nothing nearer can remain.
 *
 * "Under the cursor" for a point with no surface means "within a few pixels of
 * the ray", and a few pixels is more metres far away than close up, so the
 * tolerance is a function of distance along the ray. The frontmost point within
 * it wins: the one the user can see.
 *
 * Pure, in the cloud's own local coordinates; `renderer.ts` moves the ray into
 * them and the hit back out.
 */

export type PointIndex = {
  positions: Float32Array;
  min: [number, number, number];
  cellSize: number;
  dims: [number, number, number];
  /** Point indices sorted by cell; `starts[c]..starts[c + 1]` are cell `c`'s. */
  order: Uint32Array;
  starts: Uint32Array;
};

export type PointHit = {
  /** Index into the positions (÷ 3). */
  index: number;
  /** Distance along the ray, in the index's units. */
  t: number;
};

/** Points per cell the grid aims for; a cell is tested whole when the ray passes it. */
const TARGET_PER_CELL = 48;
/** A ceiling on cells, so a degenerate extent cannot allocate a huge grid. */
const MAX_CELLS = 1 << 21;

export function buildPointIndex(positions: Float32Array): PointIndex {
  const count = Math.floor(positions.length / 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (count === 0) {
    return { positions, min: [0, 0, 0], cellSize: 1, dims: [1, 1, 1], order: new Uint32Array(0), starts: new Uint32Array(2) };
  }

  const extent = [0, 1, 2].map((axis) => max[axis] - min[axis]);
  const largest = Math.max(...extent, 1e-6);
  // A scan is mostly surfaces, so size the cells by area rather than volume:
  // a floor patch has no depth, and a volume-based size would make its cells
  // enormous. The square root of (area per cell) over the two largest extents.
  const [a, b] = [...extent].sort((x, y) => y - x);
  const area = Math.max(a * Math.max(b, largest * 1e-3), 1e-9);
  let cellSize = Math.sqrt(area / Math.max(1, count / TARGET_PER_CELL));
  cellSize = Math.max(cellSize, largest / 1024, 1e-6);

  const dimsFor = (size: number) =>
    extent.map((value) => Math.max(1, Math.floor(value / size) + 1)) as [number, number, number];
  let dims = dimsFor(cellSize);
  while (dims[0] * dims[1] * dims[2] > MAX_CELLS) {
    cellSize *= 1.5;
    dims = dimsFor(cellSize);
  }

  const cellOf = (i: number) => {
    const x = Math.min(dims[0] - 1, Math.floor((positions[i * 3] - min[0]) / cellSize));
    const y = Math.min(dims[1] - 1, Math.floor((positions[i * 3 + 1] - min[1]) / cellSize));
    const z = Math.min(dims[2] - 1, Math.floor((positions[i * 3 + 2] - min[2]) / cellSize));
    return (z * dims[1] + y) * dims[0] + x;
  };

  // Counting sort by cell: two passes, no per-cell arrays.
  const cells = dims[0] * dims[1] * dims[2];
  const starts = new Uint32Array(cells + 1);
  const cellIds = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const cell = cellOf(i);
    cellIds[i] = cell;
    starts[cell + 1] += 1;
  }
  for (let c = 0; c < cells; c += 1) starts[c + 1] += starts[c];
  const cursor = starts.slice(0, cells);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[cursor[cellIds[i]]++] = i;

  return { positions, min, cellSize, dims, order, starts };
}

/**
 * The frontmost point within `tolerance(t)` of the ray `origin + t·direction`
 * (`direction` a unit vector), or null.
 *
 * `accept` lets the caller reject a point that is not on screen — sliced away
 * by a section plane — without the index knowing what a section is.
 */
export function pickPointOnRay(
  index: PointIndex,
  origin: [number, number, number],
  direction: [number, number, number],
  tolerance: (t: number) => number,
  accept: (pointIndex: number) => boolean = () => true,
): PointHit | null {
  const { positions, min, cellSize, dims, order, starts } = index;
  if (order.length === 0) return null;
  const max = [0, 1, 2].map((axis) => min[axis] + dims[axis] * cellSize);

  // Where the ray is inside the grid's box, widened by the largest tolerance it
  // can need there — a point just outside a cell can still be within reach.
  // The tolerance is largest at the far side of the box, so that bounds it.
  let far = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    far += Math.max((min[axis] - origin[axis]) ** 2, (max[axis] - origin[axis]) ** 2);
  }
  const margin = Math.max(cellSize, tolerance(Math.sqrt(far)));
  let tEnter = 0;
  let tExit = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const d = direction[axis];
    if (Math.abs(d) < 1e-12) {
      if (origin[axis] < min[axis] - margin || origin[axis] > max[axis] + margin) return null;
      continue;
    }
    let t0 = (min[axis] - margin - origin[axis]) / d;
    let t1 = (max[axis] + margin - origin[axis]) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tEnter = Math.max(tEnter, t0);
    tExit = Math.min(tExit, t1);
  }
  if (tEnter > tExit) return null;

  const visited = new Set<number>();
  let best: PointHit | null = null;
  let bestOffset = Infinity;

  const testCell = (x: number, y: number, z: number) => {
    const cell = (z * dims[1] + y) * dims[0] + x;
    if (visited.has(cell)) return;
    visited.add(cell);
    for (let k = starts[cell]; k < starts[cell + 1]; k += 1) {
      const i = order[k];
      const vx = positions[i * 3] - origin[0];
      const vy = positions[i * 3 + 1] - origin[1];
      const vz = positions[i * 3 + 2] - origin[2];
      const t = vx * direction[0] + vy * direction[1] + vz * direction[2];
      if (t <= 0) continue;
      const offset = vx * vx + vy * vy + vz * vz - t * t;
      const reach = tolerance(t);
      if (offset > reach * reach) continue;
      // Frontmost wins; between two at the same depth, the one nearer the ray.
      if (best && (t > best.t + 1e-9 || (Math.abs(t - best.t) <= 1e-9 && offset >= bestOffset))) continue;
      if (!accept(i)) continue;
      best = { index: i, t };
      bestOffset = offset;
    }
  };

  // March in steps of half a cell, testing the neighbourhood the tolerance
  // reaches. Simple rather than a strict DDA: a cell visited twice is skipped.
  const step = cellSize * 0.5;
  for (let t = tEnter; t <= tExit; t += step) {
    // Nothing further along can be nearer than what has been found.
    if (best && t - 2 * cellSize > (best as PointHit).t) break;
    const px = origin[0] + direction[0] * t;
    const py = origin[1] + direction[1] * t;
    const pz = origin[2] + direction[2] * t;
    const cx = Math.floor((px - min[0]) / cellSize);
    const cy = Math.floor((py - min[1]) / cellSize);
    const cz = Math.floor((pz - min[2]) / cellSize);
    // How many cells the tolerance spans. Where the grid is small along an axis
    // that whole reach is affordable (and needed: a cloud of a few points has
    // tiny cells); where it is large, three cells is already past the point
    // where the points under the cursor overlap on screen, so it is capped.
    const reach = Math.max(1, Math.ceil(tolerance(t) / cellSize));
    const span = (axis: number, centre: number): [number, number] => {
      const r = dims[axis] <= 16 ? reach : Math.min(reach, 3);
      return [Math.max(0, centre - r), Math.min(dims[axis] - 1, centre + r)];
    };
    const [x0, x1] = span(0, cx);
    const [y0, y1] = span(1, cy);
    const [z0, z1] = span(2, cz);
    for (let z = z0; z <= z1; z += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) testCell(x, y, z);
      }
    }
  }
  return best;
}
