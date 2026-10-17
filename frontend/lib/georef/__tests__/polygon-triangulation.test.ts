import { describe, expect, it } from "vitest";
import { polygonTriangles } from "../polygon-triangulation";

type Point = [number, number, number];
const outline = [[0,0], [6,0], [6,6], [4,6], [4,2], [2,2], [2,6], [0,6], [0,0]];
const hole = [[0.5,3], [1.5,3], [1.5,4], [0.5,4], [0.5,3]];

describe("3D polygon triangulation", () => {
  for (const [name, point, axes] of [
    ["horizontal roof", (x: number, y: number): Point => [700000 + x, 4500000 + y, 100], [0,1]],
    ["vertical east wall", (x: number, y: number): Point => [700000, 4500000 + x, 100 + y], [1,2]],
    ["vertical north wall", (x: number, y: number): Point => [700000 + x, 4500000, 100 + y], [0,2]],
    ["sloping roof", (x: number, y: number): Point => [700000 + x, 4500000 + y, 100 + 0.2 * x + 0.3 * y], [0,1]],
  ] as const) {
    for (const reverse of [false, true]) {
      it(`keeps the concave boundary, holes and winding of a ${name} (${reverse ? "CW" : "CCW"})`, () => {
        const rings = [outline, hole].map((ring) => ring.map(([x,y]) => point(x,y)));
        if (reverse) rings.forEach((ring) => ring.reverse());
        const triangles = polygonTriangles(rings);
        const [u,v] = axes;
        let total = 0;
        for (const [a,b,c] of triangles) {
          const area = ((b[u]-a[u])*(c[v]-a[v])-(b[v]-a[v])*(c[u]-a[u]))/2;
          expect(Math.sign(area)).toBe(reverse ? -1 : 1);
          total += Math.abs(area);
          for (const vertex of [a,b,c]) expect(rings.flat()).toContainEqual(vertex);
        }
        // 6×6 minus the 2×4 notch and the 1×1 hole. A fan gives overlapping
        // triangles outside this boundary; filling the hole adds another m².
        expect(total).toBeCloseTo(27, 6);
      });
    }
  }

  it("handles collinear first vertices and repeated consecutive vertices", () => {
    const ring: Point[] = [[0,0,0], [1,0,0], [1,0,0], [2,0,0], [2,2,0], [0,2,0], [0,0,0]];
    const triangles = polygonTriangles([ring]);
    expect(triangles.reduce((sum, [a,b,c]) => sum + Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2, 0)).toBe(4);
  });

  it("does not emit triangles for empty or degenerate rings", () => {
    expect(polygonTriangles([])).toEqual([]);
    expect(polygonTriangles([[[0,0,0], [1,1,1], [2,2,2]]])).toEqual([]);
  });
});
