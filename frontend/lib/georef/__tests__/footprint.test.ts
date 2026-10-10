import { describe, expect, it } from "vitest";

import type { MeshView, Vec3 } from "@/lib/ifc/types";
import {
  convexHull,
  featureBounds,
  footprintToGeoJson,
  planPointsFromMeshes,
  type PlanPoint,
} from "../footprint";
import type { Placement } from "../transform";

const PLACEMENT: Placement = {
  epsg: 3763,
  lengthUnitScale: 1,
  conversion: {
    eastings: -40_000,
    northings: 180_000,
    orthogonalHeight: 190,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
  },
};

function mesh(origin: Vec3, vertices: number[]): MeshView {
  return {
    expressId: 1,
    origin,
    positions: new Float32Array(vertices),
    normals: new Float32Array(vertices.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

describe("convexHull", () => {
  it("returns the corners of a square, dropping interior points", () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
      [3, 7],
    ]);

    expect(hull).toHaveLength(4);
    expect(hull).toEqual(
      expect.arrayContaining([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    );
  });

  it("drops points on an edge, which are not corners", () => {
    const hull = convexHull([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([5, 0]);
  });

  it("winds counter-clockwise", () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);

    // Shoelace: positive area means counter-clockwise.
    let area = 0;
    for (let i = 0; i < hull.length; i += 1) {
      const [x1, y1] = hull[i];
      const [x2, y2] = hull[(i + 1) % hull.length];
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
  });

  it("survives a straight wall, where the hull collapses", () => {
    // All collinear: a real case (a single wall), and one where a naive chain
    // returns nothing.
    const hull = convexHull([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(hull).toHaveLength(2);
    expect(hull).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("survives a single column and an empty model", () => {
    expect(convexHull([[3, 4]])).toEqual([[3, 4]]);
    expect(convexHull([])).toEqual([]);
  });

  it("ignores duplicated and non-finite points", () => {
    const hull = convexHull([
      [0, 0],
      [0, 0],
      [10, 0],
      [Number.NaN, 5],
      [10, 10],
      [0, 10],
    ]);
    expect(hull).toHaveLength(4);
  });
});

describe("planPointsFromMeshes", () => {
  it("converts the render frame back to IFC plan coordinates", () => {
    // Render is Y-up; IFC is Z-up. plan x = render x, plan y = −render z.
    // Getting the sign wrong mirrors the footprint, which on a symmetric
    // building looks entirely plausible.
    const points = planPointsFromMeshes(
      [mesh([0, 0, 0], [10, 0, -20])],
      [0, 0, 0],
      1,
    );
    expect(points).toEqual([[10, 20]]);
  });

  it("undoes the RTC shift", () => {
    const points = planPointsFromMeshes(
      [mesh([0, 0, 0], [0, 0, 0])],
      [100, 0, -200],
      1,
    );
    expect(points).toEqual([[100, 200]]);
  });

  it("includes each mesh's origin", () => {
    const points = planPointsFromMeshes(
      [mesh([5, 0, -5], [1, 0, -1])],
      [0, 0, 0],
      1,
    );
    expect(points).toEqual([[6, 6]]);
  });

  it("returns project units, not metres", () => {
    // A millimetre model's plan coordinates must come back in millimetres, or
    // the map conversion applies its unit scale twice.
    const points = planPointsFromMeshes(
      [mesh([0, 0, 0], [10, 0, 0])],
      [0, 0, 0],
      0.001,
    );
    expect(points[0][0]).toBeCloseTo(10_000, 6);
  });

  it("strides through large models rather than reading every vertex", () => {
    const vertices: number[] = [];
    for (let i = 0; i < 3000; i += 1) vertices.push(i, 0, 0);

    const points = planPointsFromMeshes([mesh([0, 0, 0], vertices)], [0, 0, 0], 1, {
      maxVertices: 100,
    });

    expect(points.length).toBeLessThanOrEqual(100);
    expect(points.length).toBeGreaterThan(50);
  });

  it("returns nothing for a model with no geometry", () => {
    expect(planPointsFromMeshes([], [0, 0, 0], 1)).toEqual([]);
  });
});

describe("footprintToGeoJson", () => {
  const square: PlanPoint[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("produces a closed WGS84 polygon", () => {
    const feature = footprintToGeoJson(square, PLACEMENT, { name: "model.ifc" })!;

    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("Polygon");
    expect(feature.properties.name).toBe("model.ifc");

    const ring = feature.geometry.coordinates[0];
    // Four corners plus the repeated first point — an unclosed ring is invalid
    // GeoJSON, not merely untidy.
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it("lands in Portugal for a PT-TM06 placement", () => {
    const ring = footprintToGeoJson(square, PLACEMENT)!.geometry.coordinates[0];
    for (const [longitude, latitude] of ring) {
      expect(longitude).toBeGreaterThan(-9.6);
      expect(longitude).toBeLessThan(-6.1);
      expect(latitude).toBeGreaterThan(36.9);
      expect(latitude).toBeLessThan(42.2);
    }
  });

  it("returns null rather than an empty polygon", () => {
    // MapLibre renders an empty polygon silently, which reads as "the model is
    // somewhere else" rather than "there was nothing to draw".
    expect(footprintToGeoJson([], PLACEMENT)).toBeNull();
    expect(footprintToGeoJson([[0, 0]], PLACEMENT)).toBeNull();
    expect(
      footprintToGeoJson(
        [
          [0, 0],
          [1, 1],
        ],
        PLACEMENT,
      ),
    ).toBeNull();
  });

  it("moves with the map conversion", () => {
    const here = footprintToGeoJson(square, PLACEMENT)!;
    const there = footprintToGeoJson(square, {
      ...PLACEMENT,
      conversion: { ...PLACEMENT.conversion, eastings: -20_000 },
    })!;

    expect(here.geometry.coordinates[0][0][0]).not.toBeCloseTo(
      there.geometry.coordinates[0][0][0],
      6,
    );
  });
});

describe("featureBounds", () => {
  it("bounds the ring", () => {
    const feature = footprintToGeoJson(
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      PLACEMENT,
    )!;

    const [[west, south], [east, north]] = featureBounds(feature);
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
  });
});
