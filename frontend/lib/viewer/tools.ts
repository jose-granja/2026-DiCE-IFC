/**
 * Section planes and measurement — the arithmetic, kept pure and three.js-free.
 *
 * Both of these fail in ways that look plausible on screen. A section plane with
 * the wrong sign cuts away the half you wanted to keep, which reads as "the
 * model is broken" rather than "the plane is inverted". A measurement that
 * silently picks a point on a surface the section plane has already cut away
 * returns a number that is confidently, invisibly wrong. So the rules live here,
 * where they can be tested, rather than inside the renderer.
 */

import type { Vec3 } from "@/lib/ifc/types";

// ---------------------------------------------------------------------------
// Section planes
// ---------------------------------------------------------------------------

/**
 * Render-space axes. The renderer is Y-up, so for a building:
 * `y` is a horizontal cut (a floor plan), `x` and `z` are vertical cuts
 * (sections/elevations). The UI labels them that way rather than as letters.
 */
export type SectionAxis = "x" | "y" | "z";

export type SectionPlane = {
  id: string;
  axis: SectionAxis;
  /** Position along the axis, in render-space metres. */
  position: number;
  /** Which side to keep. False keeps the side below/behind the plane. */
  flipped: boolean;
  enabled: boolean;
};

/** A plane in the half-space form three.js clips with: `normal · p + constant > 0` is kept. */
export type ClipPlane = { normal: Vec3; constant: number };

const AXIS_INDEX: Record<SectionAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * Convert a section plane to its clipping half-space.
 *
 * Unflipped keeps the **lower** side (coordinate < position), which is what a
 * plan cut at a given level means: you keep what is below and look down at it.
 * Flipping keeps the upper side.
 *
 * Derivation, for axis `x` at position `p`, keeping `x < p`:
 *   normal = (−1, 0, 0), constant = p  →  −x + p > 0  ⇔  x < p
 */
export function toClipPlane(plane: SectionPlane): ClipPlane {
  const normal: Vec3 = [0, 0, 0];
  const sign = plane.flipped ? 1 : -1;
  normal[AXIS_INDEX[plane.axis]] = sign;

  // `-sign * 0` is `-0`, which compares equal to `0` but serialises as `-0` in a
  // saved workspace and in a BCF viewpoint's clipping plane. Same reasoning as
  // `normalizeZeros` in federation.ts.
  return { normal, constant: zero(-sign * plane.position) };
}

function zero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Is `point` on the kept side of every enabled plane? */
export function isPointVisible(
  point: Vec3,
  planes: SectionPlane[],
  /** Small tolerance so a point exactly on the cut is not rejected by float noise. */
  epsilon = 1e-6,
): boolean {
  for (const plane of planes) {
    if (!plane.enabled) continue;
    const { normal, constant } = toClipPlane(plane);
    const signedDistance =
      normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] + constant;
    if (signedDistance < -epsilon) return false;
  }
  return true;
}

/**
 * A plane placed sensibly for a fresh cut: the middle of the model along that
 * axis. Starting at zero puts the plane outside the model whenever the
 * federation is offset from the origin, and the user sees nothing change.
 */
export function defaultSectionPosition(
  bounds: { min: Vec3; max: Vec3 } | null,
  axis: SectionAxis,
): number {
  if (!bounds) return 0;
  const index = AXIS_INDEX[axis];
  return (bounds.min[index] + bounds.max[index]) / 2;
}

export function sectionRange(
  bounds: { min: Vec3; max: Vec3 } | null,
  axis: SectionAxis,
): { min: number; max: number } {
  if (!bounds) return { min: -100, max: 100 };
  const index = AXIS_INDEX[axis];

  // Pad slightly so the extremes can be dragged just past the model, which is
  // how a user checks they have sliced everything.
  const min = bounds.min[index];
  const max = bounds.max[index];
  const padding = Math.max((max - min) * 0.02, 0.1);
  return { min: min - padding, max: max + padding };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type Measurement = {
  id: string;
  start: Vec3;
  end: Vec3;
};

export type MeasurementReadout = {
  /** Straight-line distance, metres. */
  distance: number;
  /** Horizontal component in the render-space XZ plane (plan distance). */
  horizontal: number;
  /** Vertical component along render-space Y. Signed: positive is upward. */
  vertical: number;
  /** Per-axis deltas, for users who want the components. */
  delta: Vec3;
};

/** Straight-line distance between two points. */
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function measure(measurement: Measurement): MeasurementReadout {
  const delta: Vec3 = [
    measurement.end[0] - measurement.start[0],
    measurement.end[1] - measurement.start[1],
    measurement.end[2] - measurement.start[2],
  ];

  return {
    distance: Math.hypot(delta[0], delta[1], delta[2]),
    // Render space is Y-up, so "plan distance" is the XZ hypotenuse.
    horizontal: Math.hypot(delta[0], delta[2]),
    vertical: delta[1],
    delta,
  };
}

/**
 * Below this, a horizontal or vertical leg is drawn and labelled as if it
 * were not there — a measurement that is already purely horizontal or
 * purely vertical has one leg sitting exactly on an endpoint, and a "0 mm"
 * label there adds noise, not information.
 */
export const NEGLIGIBLE_LEG = 0.001;

/** Midpoint, for placing a label on the measurement line. */
export function midpoint(measurement: Measurement): Vec3 {
  return [
    (measurement.start[0] + measurement.end[0]) / 2,
    (measurement.start[1] + measurement.end[1]) / 2,
    (measurement.start[2] + measurement.end[2]) / 2,
  ];
}

/**
 * Where the horizontal/vertical decomposition bends: `start`'s height,
 * directly under (or over) `end`. `start → corner → end` traces the two legs
 * whose lengths are `MeasurementReadout.horizontal`/`.vertical` — drawn as
 * guide geometry so the split is something you see, not only a number in the
 * panel.
 */
export function measurementCorner(measurement: Measurement): Vec3 {
  return [measurement.end[0], measurement.start[1], measurement.end[2]];
}

/** Midpoint of the horizontal leg (`start → corner`), for labelling it. */
export function horizontalMidpoint(measurement: Measurement): Vec3 {
  const corner = measurementCorner(measurement);
  return [
    (measurement.start[0] + corner[0]) / 2,
    corner[1],
    (measurement.start[2] + corner[2]) / 2,
  ];
}

/** Midpoint of the vertical leg (`corner → end`), for labelling it. */
export function verticalMidpoint(measurement: Measurement): Vec3 {
  const corner = measurementCorner(measurement);
  return [corner[0], (corner[1] + measurement.end[1]) / 2, corner[2]];
}

/**
 * Format a length for display.
 *
 * Millimetres below a metre, metres above, always with a unit. BIM users read
 * these at a glance and a bare number is ambiguous between the two.
 */
export function formatLength(metres: number): string {
  const absolute = Math.abs(metres);
  if (absolute < 1) return `${Math.round(metres * 1000)} mm`;
  if (absolute < 10) return `${metres.toFixed(3)} m`;
  return `${metres.toFixed(2)} m`;
}

// ---------------------------------------------------------------------------
// Vector helpers, shared by angle and volume below (and, for `renderer.ts`'s
// winding-correction in `getElementVolume`, exported).
// ---------------------------------------------------------------------------

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Three vertices of a mesh triangle, in whatever space the caller is working in. */
export type Triangle = [Vec3, Vec3, Vec3];

// ---------------------------------------------------------------------------
// Angle measurement
// ---------------------------------------------------------------------------

export type AngleMeasurement = {
  id: string;
  /** The two rays meet at `vertex`; `a` and `c` are the other two clicked points. */
  a: Vec3;
  vertex: Vec3;
  c: Vec3;
};

/**
 * The angle at `vertex` between the rays to `a` and `c`, in degrees, 0–180.
 *
 * `acos` of the normalised dot product is the textbook formula; clamping its
 * argument to [-1, 1] matters in practice, not just in theory — float error
 * on two rays that are (nearly) parallel or anti-parallel pushes the raw
 * cosine fractionally past ±1, and `Math.acos` of that is `NaN`, not a
 * rounding error anyone would notice until the label went blank.
 */
export function angleBetween(measurement: AngleMeasurement): number {
  const u = subtract(measurement.a, measurement.vertex);
  const v = subtract(measurement.c, measurement.vertex);
  const denom = length(u) * length(v);
  if (denom === 0) return 0;

  const cosine = Math.min(1, Math.max(-1, dot(u, v) / denom));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Where the angle's label sits: out from `vertex` along the bisector of the
 * two rays, short of either endpoint.
 *
 * The bisector direction is the sum of the two rays' *unit* vectors — summing
 * the raw ones would pull the label toward whichever ray happens to be
 * longer, which has nothing to do with the angle itself.
 */
export function angleLabelPoint(measurement: AngleMeasurement): Vec3 {
  const u = subtract(measurement.a, measurement.vertex);
  const v = subtract(measurement.c, measurement.vertex);
  const lu = length(u);
  const lv = length(v);
  if (lu === 0 || lv === 0) return measurement.vertex;

  const bisector: Vec3 = [u[0] / lu + v[0] / lv, u[1] / lu + v[1] / lv, u[2] / lu + v[2] / lv];
  const bisectorLength = length(bisector);
  // A 180° angle's two unit rays sum to zero, leaving no single bisector;
  // the vertex itself beats dividing by zero.
  if (bisectorLength === 0) return measurement.vertex;

  const radius = Math.min(lu, lv) * 0.35;
  return [
    measurement.vertex[0] + (bisector[0] / bisectorLength) * radius,
    measurement.vertex[1] + (bisector[1] / bisectorLength) * radius,
    measurement.vertex[2] + (bisector[2] / bisectorLength) * radius,
  ];
}

/**
 * Format an angle for display: one decimal place, always — the ordinary
 * survey/CAD convention, so two measurements of "the same" corner both read
 * as plain numbers rather than one looking artificially rounder than the
 * other.
 */
export function formatAngle(degrees: number): string {
  return `${degrees.toFixed(1)}°`;
}

// ---------------------------------------------------------------------------
// Area measurement
// ---------------------------------------------------------------------------

export type PointsAreaMeasurement = {
  id: string;
  kind: "points";
  /** Three or more points, in click order; the polygon closes from the last point back to the first. */
  points: Vec3[];
};

export type FaceAreaMeasurement = {
  id: string;
  kind: "face";
  modelId: string;
  expressId: number;
  /**
   * The detected face's own triangles, in the mesh's local space (see
   * `meshVolume`'s doc comment on why local space is exactly as correct as
   * world space here, and cheaper). The raw fact; area, centroid and outline
   * are all derived from it on demand — `facePatchArea`, `facePatchCentroid`,
   * `facePatchOutline` — the same way `measure()` derives a distance
   * measurement's readout rather than storing it.
   */
  triangles: Triangle[];
};

export type AreaMeasurement = PointsAreaMeasurement | FaceAreaMeasurement;

/**
 * Area of a polygon in 3D, via Newell's method: sum the cross products of
 * consecutive vertex pairs about an arbitrary shared origin, and take half
 * the magnitude of the result. Reduces to the familiar 2D shoelace formula
 * for a polygon confined to a coordinate plane, but — unlike the shoelace
 * formula — needs no plane-fitting step first, which is what makes it usable
 * on a polygon that only roughly lies in a plane: exactly what clicking
 * points on a real, not-perfectly-flat surface produces.
 */
export function polygonArea(points: Vec3[]): number {
  if (points.length < 3) return 0;

  let sum: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const c = cross(current, next);
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
  }
  return length(sum) / 2;
}

/**
 * Centroid of a polygon's vertices, for placing its area label. The plain
 * average, not area-weighted: good enough for a label position, and area
 * weighting would need the same triangulation this function exists to avoid.
 */
export function polygonCentroid(points: Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
    [0, 0, 0],
  );
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

/**
 * Format an area for display, always in m² — a room or a floor plate is
 * never usefully read in mm², and the digits just get harder to place at a
 * glance as the number grows, not switch units the way a length does.
 */
export function formatArea(squareMetres: number): string {
  return `${squareMetres.toFixed(squareMetres < 1000 ? 2 : 0)} m²`;
}

// ---------------------------------------------------------------------------
// Face area detection
//
// The "points" area measurement above asks the user to trace a shape by
// hand. This asks them to click once on a flat face — a wall, a slab's
// topside — and finds its extent for them.
// ---------------------------------------------------------------------------

/** Area of the triangle a–b–c. */
export function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return length(cross(subtract(b, a), subtract(c, a))) / 2;
}

/**
 * A position, rounded rather than exact, so it can key an edge shared by two
 * triangles authored as separate sub-meshes. Two vertices meant to be "the
 * same point" rarely land on the identical float bit pattern, and a key that
 * required that would silently stop `floodFillCoplanarPatch` at the first
 * sub-mesh seam of a multi-part entity.
 */
function posKey(v: Vec3): string {
  return `${v[0].toFixed(5)},${v[1].toFixed(5)},${v[2].toFixed(5)}`;
}

/** An unordered edge's key — direction does not distinguish an edge shared by two differently-wound triangles. */
function edgeKey(a: Vec3, b: Vec3): string {
  const ka = posKey(a);
  const kb = posKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function triangleEdgePairs(t: Triangle): Array<[Vec3, Vec3]> {
  return [
    [t[0], t[1]],
    [t[1], t[2]],
    [t[2], t[0]],
  ];
}

/**
 * The connected, coplanar patch of `triangles` reachable from
 * `triangles[seedIndex]` by crossing shared edges — the flat "face" a click
 * landed on.
 *
 * Two triangles are "coplanar" here if every vertex of the second lies
 * within `planeEpsilon` of the *seed* triangle's plane — checked against the
 * seed throughout the flood fill, never triangle-to-triangle, so small
 * errors cannot drift across a large patch into merging two faces that are
 * not really flat together. This also makes the test winding-agnostic: IFC
 * mesh winding is not reliable (AGENTS.md §5), but how far a vertex sits from
 * a plane does not depend on which way the triangle that plane came from was
 * wound.
 *
 * Adjacency is by vertex *position*, not index, for the same reason
 * `posKey` is rounded: one entity's mesh can be assembled from several
 * sub-shapes whose shared edge is described by two different sets of vertex
 * indices, and position is the only thing that is actually equal there.
 *
 * Stops at a physically different face automatically, with no special case
 * for it: a wall's front and back faces are parallel but not coplanar (they
 * fail the plane-distance test), and its side faces are neither parallel nor
 * connected to the front face by a shared edge in the first place.
 */
export function floodFillCoplanarPatch(
  triangles: Triangle[],
  seedIndex: number,
  planeEpsilon = 1e-4,
): Triangle[] {
  const seed = triangles[seedIndex];
  const normal = cross(subtract(seed[1], seed[0]), subtract(seed[2], seed[0]));
  const planePoint = seed[0];

  const isCoplanarWithSeed = (t: Triangle) =>
    t.every((v) => Math.abs(dot(normal, subtract(v, planePoint))) <= planeEpsilon);

  const edgeMap = new Map<string, number[]>();
  triangles.forEach((t, i) => {
    for (const [p, q] of triangleEdgePairs(t)) {
      const key = edgeKey(p, q);
      const list = edgeMap.get(key);
      if (list) list.push(i);
      else edgeMap.set(key, [i]);
    }
  });

  const visited = new Set<number>([seedIndex]);
  const queue = [seedIndex];
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const [p, q] of triangleEdgePairs(triangles[index])) {
      for (const neighbour of edgeMap.get(edgeKey(p, q)) ?? []) {
        if (visited.has(neighbour) || !isCoplanarWithSeed(triangles[neighbour])) continue;
        visited.add(neighbour);
        queue.push(neighbour);
      }
    }
  }

  return [...visited].map((i) => triangles[i]);
}

/** Total area of a face patch — the sum of its triangles' own areas. */
export function facePatchArea(triangles: Triangle[]): number {
  return triangles.reduce((sum, [a, b, c]) => sum + triangleArea(a, b, c), 0);
}

/** Area-weighted centroid of a face patch, for placing its label. */
export function facePatchCentroid(triangles: Triangle[]): Vec3 {
  let area = 0;
  let weighted: Vec3 = [0, 0, 0];
  for (const [a, b, c] of triangles) {
    const triArea = triangleArea(a, b, c);
    const triCentroid: Vec3 = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ];
    area += triArea;
    weighted = [
      weighted[0] + triCentroid[0] * triArea,
      weighted[1] + triCentroid[1] * triArea,
      weighted[2] + triCentroid[2] * triArea,
    ];
  }
  // Every triangle in a real patch has positive area; this is only reachable
  // from an empty or degenerate patch, and the first vertex beats NaN.
  if (area === 0) return triangles[0]?.[0] ?? [0, 0, 0];
  return [weighted[0] / area, weighted[1] / area, weighted[2] / area];
}

/**
 * The patch's outer boundary, as consecutive point pairs ready for
 * `LineSegments` — deliberately *not* ordered into a loop, which drawing as
 * independent segments never needs.
 *
 * An edge shared by two triangles in the patch is interior to it; one that
 * belongs to only a single triangle of the patch is on its boundary. Counting
 * every triangle's three edges and keeping the ones seen exactly once is the
 * whole algorithm — cheaper than, and with no need for, walking the boundary
 * into an ordered polygon.
 */
export function facePatchOutline(triangles: Triangle[]): Vec3[] {
  const edges = new Map<string, { count: number; a: Vec3; b: Vec3 }>();
  for (const t of triangles) {
    for (const [p, q] of triangleEdgePairs(t)) {
      const key = edgeKey(p, q);
      const existing = edges.get(key);
      if (existing) existing.count += 1;
      else edges.set(key, { count: 1, a: p, b: q });
    }
  }

  const outline: Vec3[] = [];
  for (const { count, a, b } of edges.values()) {
    if (count === 1) outline.push(a, b);
  }
  return outline;
}

// ---------------------------------------------------------------------------
// Volume measurement
// ---------------------------------------------------------------------------

export type ElementVolumeMeasurement = {
  id: string;
  kind: "element";
  modelId: string;
  expressId: number;
  volume: number;
  /** The entity's own bounding-box centre, for placing its label. */
  centroid: Vec3;
};

export type BoxVolumeMeasurement = {
  id: string;
  kind: "box";
  /** Opposite corners of an axis-aligned box in render space. */
  corner1: Vec3;
  corner2: Vec3;
};

export type VolumeMeasurement = ElementVolumeMeasurement | BoxVolumeMeasurement;

/** Volume of the axis-aligned box with `corner1` and `corner2` as opposite corners. */
export function boxVolume(corner1: Vec3, corner2: Vec3): number {
  return (
    Math.abs(corner2[0] - corner1[0]) *
    Math.abs(corner2[1] - corner1[1]) *
    Math.abs(corner2[2] - corner1[2])
  );
}

/** Centre of the axis-aligned box with `corner1` and `corner2` as opposite corners. */
export function boxCentre(corner1: Vec3, corner2: Vec3): Vec3 {
  return [
    (corner1[0] + corner2[0]) / 2,
    (corner1[1] + corner2[1]) / 2,
    (corner1[2] + corner2[2]) / 2,
  ];
}

/**
 * Volume enclosed by a closed triangle mesh, via the divergence theorem: sum
 * each triangle's signed tetrahedron volume against an arbitrary shared
 * vertex — the origin, here — and take the absolute value of the total.
 *
 * Valid from any fixed reference point, not only the origin or the mesh's own
 * centroid: a closed surface's net outward flux through a constant vector
 * field is zero, so translating the reference point changes nothing about
 * the result. That is also why this wants the mesh's *local* vertex
 * coordinates rather than their world-space equivalent — a model's placement
 * in the scene is a rigid transform, rotation and translation with no scale
 * (see `ViewerRenderer`'s model-group setup), and a rigid transform preserves
 * volume outright, so transforming first would spend work to change nothing.
 *
 * Requires every triangle to wind the same way — all outward, or all inward,
 * consistently — or contributions from different faces cancel instead of
 * summing. **IFC-derived meshes cannot be assumed to have this**: AGENTS.md
 * §5 notes their winding is unreliable, which is exactly why the renderer's
 * materials are double-sided rather than depending on it. `ViewerRenderer
 * .getElementVolume` is the caller for real geometry, and it corrects each
 * triangle's winding against the mesh's authored per-vertex normals — which
 * remain trustworthy even when winding is not — before it ever reaches here.
 */
export function meshVolume(triangles: Triangle[]): number {
  let sixVolume = 0;
  for (const [a, b, c] of triangles) sixVolume += dot(a, cross(b, c));
  return Math.abs(sixVolume) / 6;
}

/**
 * Format a volume for display, always in m³ — the unit every IFC quantity
 * set and every structural drawing already uses for an element's volume.
 */
export function formatVolume(cubicMetres: number): string {
  return `${cubicMetres.toFixed(2)} m³`;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/**
 * The kinds of geometry a picked point can snap to on the triangle it hit.
 * Each has a different marker shape in the viewport (`renderer.ts`), so a
 * user can tell at a glance which one a click is about to land on.
 */
export type SnapTargetType = "corner" | "edgeMidpoint" | "edge";

/** Which snap target types are currently active, independently toggleable. */
export type SnapTargets = Record<SnapTargetType, boolean>;

/** Is any snap target enabled? When none are, `pickPoint` should not bother computing candidates at all. */
export function hasAnySnapTarget(targets: SnapTargets): boolean {
  return targets.corner || targets.edgeMidpoint || targets.edge;
}

function segmentMidpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** The closest point to `point` lying on segment `a`–`b`, clamped to the segment. */
function nearestPointOnSegment(point: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (lengthSquared === 0) return a;

  const ap: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const t = Math.min(
    1,
    Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSquared),
  );
  return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
}

export type SnapResult = {
  point: Vec3;
  snapped: boolean;
  /** Which kind of target it landed on — null when unsnapped. */
  type: SnapTargetType | null;
};

type SnapCandidate = { point: Vec3; type: SnapTargetType };

function triangleEdges(triangle: [Vec3, Vec3, Vec3]): Array<[Vec3, Vec3]> {
  const [a, b, c] = triangle;
  return [
    [a, b],
    [b, c],
    [c, a],
  ];
}

/** The nearest of `candidates` to `point`, within `threshold` — unsnapped otherwise. */
function nearestCandidate(
  point: Vec3,
  threshold: number,
  candidates: SnapCandidate[],
): SnapResult {
  let bestPoint: Vec3 | null = null;
  let bestType: SnapTargetType | null = null;
  let bestDistance = threshold;

  for (const candidate of candidates) {
    const d = distance(point, candidate.point);
    if (d <= bestDistance) {
      bestDistance = d;
      bestPoint = candidate.point;
      bestType = candidate.type;
    }
  }

  return bestPoint && bestType
    ? { point: bestPoint, snapped: true, type: bestType }
    : { point, snapped: false, type: null };
}

/**
 * Snap a picked point to whichever enabled target on the hit triangle
 * applies: a corner, an edge's midpoint, or the nearest point anywhere along
 * an edge.
 *
 * Measuring between corners is what people actually want by default — a raw
 * ray/triangle intersection lands wherever the cursor happened to be, and two
 * measurements of "the same" edge then differ by millimetres — but a
 * fixture's centreline or a wall's true edge sometimes needs the other two.
 *
 * Corners and edge midpoints are tried first, as a group, nearest-wins
 * between them; "nearest point on an edge" is tried only when neither found
 * anything in range. It cannot be nearest-wins across all three: a corner and
 * an edge are inherently entangled — right next to a corner, the nearest
 * point on the adjoining edge, clamped to the segment, *is* that corner, so a
 * flat distance comparison is a coin flip between reporting the precise
 * target and the continuum that happens to pass through it. Since "anywhere
 * on an edge" already includes every corner and midpoint as limiting cases,
 * letting it compete on equal footing means it can — and, on ties, does —
 * swallow the more specific targets it was meant to supplement.
 *
 * Snapping is limited to the hit triangle's own geometry: cheap, predictable,
 * and it cannot jump to a different element the way a radius search can.
 * Returns the original point, unsnapped, when nothing enabled is within
 * `threshold` — snapping degrades to free picking rather than yanking to a
 * distant target.
 */
export function snapToTriangle(
  point: Vec3,
  triangle: [Vec3, Vec3, Vec3],
  threshold: number,
  targets: SnapTargets,
): SnapResult {
  const edges = triangleEdges(triangle);

  const preciseCandidates: SnapCandidate[] = [];
  if (targets.corner) {
    for (const vertex of triangle) preciseCandidates.push({ point: vertex, type: "corner" });
  }
  if (targets.edgeMidpoint) {
    for (const [p1, p2] of edges) {
      preciseCandidates.push({ point: segmentMidpoint(p1, p2), type: "edgeMidpoint" });
    }
  }

  if (preciseCandidates.length > 0) {
    const precise = nearestCandidate(point, threshold, preciseCandidates);
    if (precise.snapped) return precise;
  }

  if (!targets.edge) return { point, snapped: false, type: null };

  const edgeCandidates: SnapCandidate[] = edges.map(([p1, p2]) => ({
    point: nearestPointOnSegment(point, p1, p2),
    type: "edge",
  }));
  return nearestCandidate(point, threshold, edgeCandidates);
}

/**
 * Snap threshold scaled to how far away the camera is.
 *
 * A fixed distance in metres is wrong at both ends: at 100 m away a 50 mm
 * threshold never triggers, and up close it swallows small details. Tying it to
 * viewing distance keeps it roughly constant on screen.
 */
export function snapThresholdFor(distanceToCamera: number): number {
  return Math.min(Math.max(distanceToCamera * 0.02, 0.01), 1);
}
