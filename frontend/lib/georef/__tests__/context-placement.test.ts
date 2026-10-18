import { describe, expect, it } from "vitest";
import type { Vec3 } from "@/lib/ifc/types";
import { placeContextGeometry, type ContextScenePlacement } from "../context-placement";
import { localToMap, type Placement } from "../transform";

const placement: Placement = {
  epsg: 3763, lengthUnitScale: 1,
  conversion: {
    eastings: -40000, northings: 180000, orthogonalHeight: 190,
    xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
  },
};
const originShift: Vec3 = [100, 7, -200];
const model: ContextScenePlacement = { offset: [10, 20, 30], rotationY: Math.PI / 2, scale: 1 };

describe("context placement", () => {
  it("places a distant WFS origin through the complete IFC scene transform", () => {
    // Gaia's land-use response includes complete polygons spanning kilometres,
    // even for a small query area. Its geometry origin need not be near the IFC.
    const actual = placeContextGeometry({
      easting: -35861.757032225476, northing: 156678.3177066812, height: 0,
    }, placement, originShift, model);
    // Model render origin maps to (-40200, 180100, 197); group offset is added.
    expect(actual.offset[0]).toBeCloseTo(4348.242967774524, 7);
    expect(actual.offset[1]).toBeCloseTo(-177, 7);
    expect(actual.offset[2]).toBeCloseTo(23451.6822933188, 7);
    expect(actual.rotationY).toBeCloseTo(0, 12);
    expect(actual.scale).toBe(1);
  });

  it.each([
    { unit: 1, mapScale: 1 },
    { unit: 0.001, mapScale: 0.001 },
    { unit: 0.001, mapScale: 0.9996 },
    { unit: 0.3048, mapScale: 0.3048 },
  ])("aligns the same surveyed point independently of context origin ($unit, $mapScale)", ({ unit, mapScale }) => {
    const conversion = {
      ...placement.conversion, xAxisAbscissa: Math.cos(0.3), xAxisOrdinate: Math.sin(0.3), scale: mapScale,
    };
    const reference = { ...placement, lengthUnitScale: unit, conversion };
    // Deliberately different from map conversion: also exercise draft edits and
    // manual model transforms, where the net context rotation/scale is nonzero.
    const scene = { ...model, rotationY: -0.7, scale: 1.2 };
    const surveyed = localToMap({ x: 112 / unit, y: 195 / unit, z: 10 / unit }, reference);
    for (const distance of [0, 20000]) {
      const origin = { easting: surveyed.easting + distance, northing: surveyed.northing - distance / 2, height: 150 };
      const transform = placeContextGeometry(origin, reference, originShift, scene);
      const delta = [surveyed.easting - origin.easting, surveyed.height! - origin.height, -(surveyed.northing - origin.northing)];
      const cos = Math.cos(transform.rotationY), sin = Math.sin(transform.rotationY);
      const actual = [
        transform.offset[0] + transform.scale * (cos * delta[0] + sin * delta[2]),
        transform.offset[1] + transform.scale * delta[1],
        transform.offset[2] + transform.scale * (-sin * delta[0] + cos * delta[2]),
      ];
      // Known IFC render metres [112,10,-195] minus RTC [100,7,-200]
      // gives [12,3,5], then the renderer's group transform.
      const expected = [
        10 + 1.2 * (Math.cos(-0.7) * 12 + Math.sin(-0.7) * 5),
        20 + 1.2 * 3,
        30 + 1.2 * (-Math.sin(-0.7) * 12 + Math.cos(-0.7) * 5),
      ];
      actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 7));
    }
  });

  it("keeps an ungeoreferenced preview at its local origin", () => {
    expect(placeContextGeometry({ easting: 10000, northing: 20000, height: 5 }, null, originShift, model))
      .toEqual({ offset: [0, 0, 0], rotationY: 0, scale: 1 });
  });
});
