import { describe, expect, it } from "vitest";

import type { Vec3 } from "@/lib/ifc/types";
import {
  angleBetween,
  angleLabelPoint,
  boxCentre,
  boxVolume,
  defaultSectionPosition,
  distance,
  facePatchArea,
  facePatchCentroid,
  facePatchOutline,
  floodFillCoplanarPatch,
  formatAngle,
  formatArea,
  formatLength,
  formatVolume,
  hasAnySnapTarget,
  horizontalMidpoint,
  isPointVisible,
  measure,
  measurementCorner,
  meshVolume,
  midpoint,
  polygonArea,
  polygonCentroid,
  rotateSectionPlane,
  sectionRange,
  snapThresholdFor,
  snapToTriangle,
  toClipPlane,
  triangleArea,
  verticalMidpoint,
  type AngleMeasurement,
  type SectionPlane,
  type SnapTargets,
  type Triangle,
} from "../tools";

function plane(overrides: Partial<SectionPlane> = {}): SectionPlane {
  return {
    id: "p",
    axis: "y",
    position: 0,
    rotation: 0,
    flipped: false,
    enabled: true,
    ...overrides,
  };
}

describe("section planes", () => {
  it("keeps the lower side by default", () => {
    // A plan cut at level 3 keeps what is below and looks down at it.
    const cut = plane({ axis: "y", position: 3 });
    expect(isPointVisible([0, 1, 0], [cut])).toBe(true);
    expect(isPointVisible([0, 5, 0], [cut])).toBe(false);
  });

  it("keeps the upper side when flipped", () => {
    const cut = plane({ axis: "y", position: 3, flipped: true });
    expect(isPointVisible([0, 1, 0], [cut])).toBe(false);
    expect(isPointVisible([0, 5, 0], [cut])).toBe(true);
  });

  it("produces a unit normal and the matching constant", () => {
    const { normal, constant } = toClipPlane(plane({ axis: "x", position: 4 }));
    expect(normal).toEqual([-1, 0, 0]);
    expect(constant).toBe(4);

    // The half-space test itself: -x + 4 > 0 ⇔ x < 4.
    expect(-3 + constant).toBeGreaterThan(0);
    expect(-5 + constant).toBeLessThan(0);
  });

  it("flipping negates both the normal and the constant", () => {
    const unflipped = toClipPlane(plane({ axis: "z", position: 2 }));
    const flipped = toClipPlane(plane({ axis: "z", position: 2, flipped: true }));

    expect(flipped.normal).toEqual([0, 0, 1]);
    expect(unflipped.normal).toEqual([0, 0, -1]);
    expect(flipped.constant).toBe(-unflipped.constant);
  });

  it("rotates a vertical plane around the Y axis", () => {
    const rotated = toClipPlane(
      plane({ axis: "x", position: 2, rotation: 90 }),
    );
    expect(rotated.normal[0]).toBeCloseTo(0, 8);
    expect(rotated.normal[1]).toBe(0);
    expect(rotated.normal[2]).toBeCloseTo(1, 8);
    expect(rotated.constant).toBe(2);
  });

  it("never emits a negative zero, which would serialise into a workspace", () => {
    const atOrigin = toClipPlane(plane({ axis: "y", position: 0, flipped: true }));
    expect(Object.is(atOrigin.constant, -0)).toBe(false);
  });

  it("keeps a point that lies exactly on the cut", () => {
    // Floating-point noise must not make the cut face itself disappear.
    expect(isPointVisible([0, 3, 0], [plane({ position: 3 })])).toBe(true);
  });

  it("ignores disabled planes", () => {
    const cut = plane({ axis: "y", position: 3, enabled: false });
    expect(isPointVisible([0, 5, 0], [cut])).toBe(true);
  });

  it("intersects several planes — a point must satisfy all of them", () => {
    const planes = [
      plane({ id: "a", axis: "y", position: 3 }),
      plane({ id: "b", axis: "x", position: 10, flipped: true }),
    ];

    expect(isPointVisible([12, 1, 0], planes)).toBe(true);
    expect(isPointVisible([12, 5, 0], planes)).toBe(false); // above the y cut
    expect(isPointVisible([2, 1, 0], planes)).toBe(false); // wrong side of x
  });

  it("defaults a new plane to the middle of the model, not the origin", () => {
    // A federation offset from the origin would otherwise get a plane that
    // misses the model entirely, and nothing appears to happen.
    const bounds = { min: [100, 0, -50] as Vec3, max: [140, 20, -10] as Vec3 };
    expect(defaultSectionPosition(bounds, "x")).toBe(120);
    expect(defaultSectionPosition(bounds, "y")).toBe(10);
    expect(defaultSectionPosition(bounds, "z")).toBe(-30);
  });

  it("falls back to zero with nothing loaded", () => {
    expect(defaultSectionPosition(null, "y")).toBe(0);
  });

  it("pads the slider range so the plane can clear the model", () => {
    const bounds = { min: [0, 0, 0] as Vec3, max: [0, 100, 0] as Vec3 };
    const range = sectionRange(bounds, "y");
    expect(range.min).toBeLessThan(0);
    expect(range.max).toBeGreaterThan(100);
  });

  it("gives a usable range for a degenerate axis", () => {
    const bounds = { min: [5, 0, 0] as Vec3, max: [5, 0, 0] as Vec3 };
    const range = sectionRange(bounds, "x");
    expect(range.max).toBeGreaterThan(range.min);
  });

  it("projects the slider range onto a rotated normal", () => {
    const bounds = { min: [0, 0, 0] as Vec3, max: [10, 2, 20] as Vec3 };
    const range = sectionRange(bounds, "x", 90);
    expect(range.min).toBeLessThan(-20);
    expect(range.max).toBeGreaterThan(0);
  });

  it("rotates around the plane point nearest the model centre", () => {
    const bounds = {
      min: [100, 0, 200] as Vec3,
      max: [140, 20, 260] as Vec3,
    };
    const rotated = rotateSectionPlane(
      plane({ axis: "x", position: 120 }),
      90,
      bounds,
    );
    expect(rotated.rotation).toBe(90);
    // The original plane crosses the model centre at [120, 10, 230]. A 90°
    // yaw measures position along -Z, so keeping that pivot gives -230.
    expect(rotated.position).toBeCloseTo(-230, 6);
  });
});

describe("measurement", () => {
  it("reports distance and its components", () => {
    const readout = measure({ id: "m", start: [0, 0, 0], end: [3, 4, 0] });
    expect(readout.distance).toBeCloseTo(5, 6);
    // Render space is Y-up: the plan distance is the XZ hypotenuse.
    expect(readout.horizontal).toBeCloseTo(3, 6);
    expect(readout.vertical).toBeCloseTo(4, 6);
  });

  it("keeps the vertical component signed so up and down differ", () => {
    expect(measure({ id: "m", start: [0, 5, 0], end: [0, 2, 0] }).vertical).toBe(-3);
    expect(measure({ id: "m", start: [0, 2, 0], end: [0, 5, 0] }).vertical).toBe(3);
  });

  it("computes plan distance across both horizontal axes", () => {
    const readout = measure({ id: "m", start: [0, 0, 0], end: [3, 0, 4] });
    expect(readout.horizontal).toBeCloseTo(5, 6);
    expect(readout.vertical).toBe(0);
  });

  it("places the label at the midpoint", () => {
    expect(midpoint({ id: "m", start: [0, 0, 0], end: [4, 2, -6] })).toEqual([
      2, 1, -3,
    ]);
  });

  it("bends the horizontal/vertical decomposition at start's height, under end", () => {
    const m = { id: "m", start: [0, 0, 0] as Vec3, end: [3, 4, 5] as Vec3 };
    expect(measurementCorner(m)).toEqual([3, 0, 5]);
  });

  it("places horizontal and vertical leg labels at each leg's own midpoint", () => {
    const m = { id: "m", start: [0, 0, 0] as Vec3, end: [4, 6, 0] as Vec3 };
    // Horizontal leg: start → corner ([4, 0, 0]) — its midpoint is [2, 0, 0].
    expect(horizontalMidpoint(m)).toEqual([2, 0, 0]);
    // Vertical leg: corner → end — its midpoint is [4, 3, 0].
    expect(verticalMidpoint(m)).toEqual([4, 3, 0]);
  });

  it("measures the distance between two points", () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 6);
    expect(distance([1, 1, 1], [1, 1, 1])).toBe(0);
  });
});

describe("formatLength", () => {
  it("uses millimetres below a metre", () => {
    expect(formatLength(0.05)).toBe("50 mm");
    expect(formatLength(0.9)).toBe("900 mm");
  });

  it("uses metres above a metre, always with a unit", () => {
    expect(formatLength(1.2345)).toBe("1.234 m");
    expect(formatLength(42.5)).toBe("42.50 m");
  });

  it("handles zero and negatives", () => {
    expect(formatLength(0)).toBe("0 mm");
    expect(formatLength(-0.25)).toBe("-250 mm");
  });
});

describe("snapping", () => {
  const triangle: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];

  const CORNERS_ONLY: SnapTargets = { corner: true, edgeMidpoint: false, edge: false };
  const MIDPOINTS_ONLY: SnapTargets = { corner: false, edgeMidpoint: true, edge: false };
  const EDGES_ONLY: SnapTargets = { corner: false, edgeMidpoint: false, edge: true };
  const NOTHING: SnapTargets = { corner: false, edgeMidpoint: false, edge: false };

  it("snaps to the nearest corner within the threshold", () => {
    const result = snapToTriangle([0.95, 0.02, 0], triangle, 0.2, CORNERS_ONLY);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe("corner");
    expect(result.point).toEqual([1, 0, 0]);
  });

  it("leaves the point alone in the middle of a large face", () => {
    // Degrading to free picking beats yanking to a corner half a metre away.
    const result = snapToTriangle([0.4, 0.4, 0], triangle, 0.05, CORNERS_ONLY);
    expect(result.snapped).toBe(false);
    expect(result.type).toBeNull();
    expect(result.point).toEqual([0.4, 0.4, 0]);
  });

  it("picks the closest of two corner candidates in range", () => {
    const result = snapToTriangle([0.1, 0.9, 0], triangle, 2, CORNERS_ONLY);
    expect(result.point).toEqual([0, 1, 0]);
  });

  it("snaps to an edge's midpoint when that target is enabled", () => {
    const result = snapToTriangle([0.55, 0.05, 0], triangle, 0.2, MIDPOINTS_ONLY);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe("edgeMidpoint");
    expect(result.point).toEqual([0.5, 0, 0]);
  });

  it("snaps to the nearest point on an edge, not just its midpoint", () => {
    const result = snapToTriangle([0.3, 0.05, 0], triangle, 0.2, EDGES_ONLY);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe("edge");
    expect(result.point).toEqual([0.3, 0, 0]);
  });

  it("clamps an edge snap to the segment rather than its infinite line", () => {
    // The nearest point on the *line* through (0,0,0)-(1,0,0) would be
    // (1.3, 0, 0), off the end of the triangle's actual edge.
    const result = snapToTriangle([1.3, 0.05, 0], triangle, 0.4, EDGES_ONLY);
    expect(result.type).toBe("edge");
    expect(result.point).toEqual([1, 0, 0]);
  });

  it("picks whichever of corner/midpoint is nearest, when both are enabled", () => {
    const both: SnapTargets = { corner: true, edgeMidpoint: true, edge: false };
    // Nearer the hypotenuse's midpoint (0.5, 0.5, 0) than either corner.
    const result = snapToTriangle([0.52, 0.48, 0], triangle, 1, both);
    expect(result.type).toBe("edgeMidpoint");
    expect(result.point).toEqual([0.5, 0.5, 0]);
  });

  it("returns the raw point, unsnapped, when nothing is enabled", () => {
    const result = snapToTriangle([0.95, 0.02, 0], triangle, 0.2, NOTHING);
    expect(result.snapped).toBe(false);
    expect(result.type).toBeNull();
    expect(result.point).toEqual([0.95, 0.02, 0]);
  });

  describe("corner and midpoint take priority over edge", () => {
    it("prefers a corner over the edge point that clamps to the same spot", () => {
      // Just past (1, 0, 0), beyond both edges that meet there: the nearest
      // point on each, clamped to its segment, lands exactly on that corner
      // too — an "edge" candidate that is a true tie with "corner", which is
      // exactly the case a flat nearest-wins comparison gets wrong.
      const all: SnapTargets = { corner: true, edgeMidpoint: true, edge: true };
      const result = snapToTriangle([1.05, -0.05, 0], triangle, 0.2, all);
      expect(result.type).toBe("corner");
      expect(result.point).toEqual([1, 0, 0]);
    });

    it("prefers an edge midpoint over the edge point at the same spot", () => {
      const all: SnapTargets = { corner: true, edgeMidpoint: true, edge: true };
      const result = snapToTriangle([0.5, 0.03, 0], triangle, 0.2, all);
      expect(result.type).toBe("edgeMidpoint");
      expect(result.point).toEqual([0.5, 0, 0]);
    });

    it("falls back to edge when the cursor is not near any corner or midpoint", () => {
      // A quarter of the way along the base — nowhere near either corner
      // (0,0,0)/(1,0,0) or that edge's midpoint (0.5, 0, 0).
      const all: SnapTargets = { corner: true, edgeMidpoint: true, edge: true };
      const result = snapToTriangle([0.25, 0.03, 0], triangle, 0.2, all);
      expect(result.type).toBe("edge");
      expect(result.point).toEqual([0.25, 0, 0]);
    });

    it("still uses edge on its own when corner/midpoint are both disabled", () => {
      const edgeOnly: SnapTargets = { corner: false, edgeMidpoint: false, edge: true };
      const result = snapToTriangle([1.05, -0.05, 0], triangle, 0.2, edgeOnly);
      expect(result.type).toBe("edge");
      expect(result.point).toEqual([1, 0, 0]);
    });
  });

  it("scales the threshold with viewing distance", () => {
    // Constant on screen rather than constant in metres.
    expect(snapThresholdFor(100)).toBeGreaterThan(snapThresholdFor(5));
    // ...but bounded at both ends, so it never swallows a whole element.
    expect(snapThresholdFor(10_000)).toBeLessThanOrEqual(1);
    expect(snapThresholdFor(0.001)).toBeGreaterThanOrEqual(0.01);
  });
});

describe("hasAnySnapTarget", () => {
  it("is true when at least one target is enabled", () => {
    expect(hasAnySnapTarget({ corner: true, edgeMidpoint: false, edge: false })).toBe(true);
    expect(hasAnySnapTarget({ corner: false, edgeMidpoint: false, edge: true })).toBe(true);
  });

  it("is false when every target is off", () => {
    expect(hasAnySnapTarget({ corner: false, edgeMidpoint: false, edge: false })).toBe(false);
  });
});

describe("angle measurement", () => {
  function angle(a: Vec3, vertex: Vec3, c: Vec3): AngleMeasurement {
    return { id: "a", a, vertex, c };
  }

  it("measures a right angle as 90°", () => {
    expect(angleBetween(angle([1, 0, 0], [0, 0, 0], [0, 1, 0]))).toBeCloseTo(90);
  });

  it("measures opposite rays as 180°", () => {
    expect(angleBetween(angle([1, 0, 0], [0, 0, 0], [-1, 0, 0]))).toBeCloseTo(180);
  });

  it("measures the same direction as 0°", () => {
    expect(angleBetween(angle([1, 0, 0], [0, 0, 0], [2, 0, 0]))).toBeCloseTo(0);
  });

  it("is not sensitive to ray length, only direction", () => {
    const unitAngle = angleBetween(angle([1, 0, 0], [0, 0, 0], [0, 1, 0]));
    const scaledAngle = angleBetween(angle([50, 0, 0], [0, 0, 0], [0, 0.001, 0]));
    expect(scaledAngle).toBeCloseTo(unitAngle);
  });

  it("returns 0° rather than NaN when a ray has zero length", () => {
    // The clicked point landed exactly on the vertex — degenerate input, not
    // a crash.
    expect(angleBetween(angle([0, 0, 0], [0, 0, 0], [0, 1, 0]))).toBe(0);
  });

  it("places the label along the bisector, short of both rays", () => {
    const point = angleLabelPoint(angle([1, 0, 0], [0, 0, 0], [0, 1, 0]));
    const radius = Math.hypot(point[0], point[1], point[2]);
    expect(radius).toBeCloseTo(0.35);
    // On the bisector of the +X and +Y rays: equal, positive x and y.
    expect(point[0]).toBeCloseTo(point[1]);
    expect(point[0]).toBeGreaterThan(0);
  });

  it("falls back to the vertex for a 180° angle, which has no single bisector", () => {
    const point = angleLabelPoint(angle([1, 0, 0], [0, 0, 0], [-1, 0, 0]));
    expect(point).toEqual([0, 0, 0]);
  });

  it("formats to one decimal place", () => {
    expect(formatAngle(63.456)).toBe("63.5°");
    expect(formatAngle(90)).toBe("90.0°");
  });
});

describe("area measurement", () => {
  it("measures a unit square as 1 m²", () => {
    const square: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(polygonArea(square)).toBeCloseTo(1);
  });

  it("measures a right triangle as half its base times height", () => {
    const triangle: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(polygonArea(triangle)).toBeCloseTo(0.5);
  });

  it("is not sensitive to winding direction", () => {
    const clockwise: Vec3[] = [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ];
    expect(polygonArea(clockwise)).toBeCloseTo(1);
  });

  it("is zero for fewer than three points", () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[0, 0, 0]])).toBe(0);
    expect(
      polygonArea([
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ).toBe(0);
  });

  it("centres the label at the vertex average", () => {
    const square: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(polygonCentroid(square)).toEqual([0.5, 0.5, 0]);
  });

  it("formats below 1000 m² with two decimals, and whole above it", () => {
    expect(formatArea(12.345)).toBe("12.35 m²");
    expect(formatArea(1500)).toBe("1500 m²");
  });
});

describe("volume measurement", () => {
  it("measures an axis-aligned box regardless of corner order", () => {
    expect(boxVolume([0, 0, 0], [2, 3, 4])).toBeCloseTo(24);
    expect(boxVolume([2, 0, 0], [0, 3, -4])).toBeCloseTo(24);
  });

  it("centres a box between its two opposite corners", () => {
    expect(boxCentre([0, 0, 0], [2, 4, 6])).toEqual([1, 2, 3]);
  });

  it("measures a closed mesh's enclosed volume via the divergence theorem", () => {
    // A unit cube from (0,0,0) to (1,1,1): 6 faces, 2 triangles each, every
    // one wound consistently outward (right-hand rule) — `meshVolume` needs
    // that agreement to sum correctly; `getElementVolume` in `renderer.ts` is
    // what re-establishes it for real, unreliably-wound IFC meshes.
    const v000: Vec3 = [0, 0, 0];
    const v100: Vec3 = [1, 0, 0];
    const v110: Vec3 = [1, 1, 0];
    const v010: Vec3 = [0, 1, 0];
    const v001: Vec3 = [0, 0, 1];
    const v101: Vec3 = [1, 0, 1];
    const v111: Vec3 = [1, 1, 1];
    const v011: Vec3 = [0, 1, 1];

    const cube: Array<[Vec3, Vec3, Vec3]> = [
      [v000, v010, v110], // bottom, z=0
      [v000, v110, v100],
      [v001, v101, v111], // top, z=1
      [v001, v111, v011],
      [v000, v100, v101], // front, y=0
      [v000, v101, v001],
      [v010, v111, v110], // back, y=1
      [v010, v011, v111],
      [v000, v011, v010], // left, x=0
      [v000, v001, v011],
      [v100, v110, v111], // right, x=1
      [v100, v111, v101],
    ];

    expect(meshVolume(cube)).toBeCloseTo(1);
  });

  it("formats to two decimal places", () => {
    expect(formatVolume(3.14159)).toBe("3.14 m³");
  });
});

describe("face area detection", () => {
  // A unit square in the z=0 plane, split into two triangles along its
  // diagonal — the shape a click on a flat face should resolve to.
  const v00: Vec3 = [0, 0, 0];
  const v10: Vec3 = [1, 0, 0];
  const v11: Vec3 = [1, 1, 0];
  const v01: Vec3 = [0, 1, 0];
  const quad: Triangle[] = [
    [v00, v10, v11],
    [v00, v11, v01],
  ];

  it("measures a triangle's area", () => {
    expect(triangleArea(v00, v10, v11)).toBeCloseTo(0.5);
  });

  it("floods across a shared edge to the rest of a flat face", () => {
    const patch = floodFillCoplanarPatch(quad, 0);
    expect(patch).toHaveLength(2);
    expect(facePatchArea(patch)).toBeCloseTo(1);
  });

  it("does not cross onto a triangle that shares an edge but is not coplanar", () => {
    // Rises in +Z from the quad's own edge (v10, v11) — a different,
    // perpendicular face, the way a wall's side face meets its front face.
    const perpendicular: Triangle = [v10, v11, [1, 0, 1]];
    const patch = floodFillCoplanarPatch([...quad, perpendicular], 0);

    expect(patch).toHaveLength(2);
    expect(facePatchArea(patch)).toBeCloseTo(1);
  });

  it("does not include a coplanar triangle it is not connected to", () => {
    // Same z=0 plane as the quad, but nowhere near it — coplanar alone is
    // not enough; only a shared edge grows the patch.
    const disconnected: Triangle = [
      [5, 5, 0],
      [6, 5, 0],
      [5, 6, 0],
    ];
    const patch = floodFillCoplanarPatch([...quad, disconnected], 0);

    expect(patch).toHaveLength(2);
    expect(facePatchArea(patch)).toBeCloseTo(1);
  });

  it("is winding-agnostic: a differently-wound coplanar neighbour still joins", () => {
    // Same triangle as quad[1], but with two vertices swapped — the winding
    // AGENTS.md §5 says IFC meshes cannot be trusted to keep consistent.
    const rewound: Triangle[] = [quad[0], [v00, v01, v11]];
    const patch = floodFillCoplanarPatch(rewound, 0);

    expect(patch).toHaveLength(2);
    expect(facePatchArea(patch)).toBeCloseTo(1);
  });

  it("centres the label at the area-weighted centroid", () => {
    expect(facePatchCentroid(quad)).toEqual([0.5, 0.5, 0]);
  });

  it("outlines only the patch's boundary, not its interior diagonal", () => {
    const outline = facePatchOutline(quad);
    // 4 boundary edges (8 points); the shared diagonal (v00-v11) appears in
    // both triangles and is therefore interior, not boundary.
    expect(outline).toHaveLength(8);

    const key = (p: Vec3) => p.join(",");
    const canonicalEdge = (p: Vec3, q: Vec3) => {
      const a = key(p);
      const b = key(q);
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    };
    const edgeKeys = new Set<string>();
    for (let i = 0; i < outline.length; i += 2) {
      edgeKeys.add(canonicalEdge(outline[i], outline[i + 1]));
    }
    expect(edgeKeys.has(canonicalEdge(v00, v11))).toBe(false);
    expect(edgeKeys.has(canonicalEdge(v00, v10))).toBe(true);
    expect(edgeKeys.has(canonicalEdge(v10, v11))).toBe(true);
    expect(edgeKeys.has(canonicalEdge(v11, v01))).toBe(true);
    expect(edgeKeys.has(canonicalEdge(v01, v00))).toBe(true);
  });
});
