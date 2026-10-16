import { describe, expect, it } from "vitest";
import { contextTriangles, type ContextTriangle } from "../vector-context";
import type { WkbGeometry, WkbPoint } from "../wkb";

const identity = (point: WkbPoint) => point;
const ring = (points: number[][]): WkbPoint[] => points.map(([x, y]) => [x, y, 0]);
const area = (triangles: ContextTriangle[]) => triangles.reduce((sum, [a, b, c]) =>
  sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);
const polygon = (rings: WkbPoint[][]): WkbGeometry => ({ polygons: [rings], lines: [], points: [] });

describe("vector context", () => {
  it("preserves concave outlines instead of filling the notch", () => {
    const shape = polygon([ring([[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]])]);
    expect(area(contextTriangles(shape, identity))).toBeCloseTo(7);
  });

  it("keeps polygon holes open, including when a clip crosses their boundary", () => {
    const shape = polygon([
      ring([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
      ring([[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]),
    ]);
    expect(area(contextTriangles(shape, identity))).toBeCloseTo(84);
    const box = { minX: 2, minY: 2, maxX: 5, maxY: 8 };
    expect(area(contextTriangles(shape, identity, box, box))).toBeCloseTo(10);
  });

  it("clips a world polygon before projecting, even when no vertex is near the site", () => {
    const shape = polygon([ring([[-180, -89], [180, -89], [180, 84], [-180, 84], [-180, -89]])]);
    const source = { minX: -9, minY: 40, maxX: -8, maxY: 41 };
    const target = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const result = contextTriangles(shape, ([x, y, z]) => {
      expect(x).toBeGreaterThanOrEqual(-9); expect(x).toBeLessThanOrEqual(-8);
      expect(y).toBeGreaterThanOrEqual(40); expect(y).toBeLessThanOrEqual(41);
      return [(x + 9) * 100, (y - 40) * 100, z];
    }, source, target);
    expect(area(result)).toBeCloseTo(10000);
  });

  it("clips crossing lines and interpolates their elevations", () => {
    const shape: WkbGeometry = { polygons: [], points: [], lines: [[[-10, 0, 0], [10, 0, 20]]] };
    const box = { minX: -2, minY: -2, maxX: 2, maxY: 2 };
    const result = contextTriangles(shape, identity, box, box);
    expect(area(result)).toBeCloseTo(6);
    expect(Math.min(...result.flat().map((p) => p[2]))).toBeCloseTo(8);
    expect(Math.max(...result.flat().map((p) => p[2]))).toBeCloseTo(12);
  });

  it("does not create non-finite render geometry for an empty point", () => {
    expect(contextTriangles({ polygons: [], lines: [], points: [[NaN, NaN, 0]] }, identity)).toEqual([]);
  });
});
