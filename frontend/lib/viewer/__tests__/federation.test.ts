import { describe, expect, it } from "vitest";

import type { CoordinateInfo, GeoreferenceView, Vec3 } from "@/lib/ifc/types";
import {
  computePlacements,
  deriveWorldOrigin,
  federatedBounds,
  gridRotationAngle,
  ifcToRender,
  mapPositionOfRenderOrigin,
  renderToIfc,
  type FederationModelInput,
} from "../federation";

const EMPTY_BOUNDS = { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };

function coordinates(originShift: Vec3 = [0, 0, 0]): CoordinateInfo {
  return {
    originShift,
    originalBounds: EMPTY_BOUNDS,
    shiftedBounds: EMPTY_BOUNDS,
    hasLargeCoordinates: originShift.some((v) => v !== 0),
    lengthUnitScale: 1,
  };
}

function georeferenced(
  eastings: number,
  northings: number,
  orthogonalHeight = 0,
  extra: Partial<GeoreferenceView["mapConversion"]> = {},
  crs = "EPSG:3763",
): GeoreferenceView {
  return {
    hasGeoreference: true,
    source: "mapConversion",
    mapConversion: { eastings, northings, orthogonalHeight, ...extra },
    projectedCRS: { name: crs },
  };
}

function model(
  id: string,
  georeference: GeoreferenceView,
  originShift: Vec3 = [0, 0, 0],
): FederationModelInput {
  return { id, name: id, coordinates: coordinates(originShift), georeference };
}

const UNREFERENCED: GeoreferenceView = { hasGeoreference: false };

describe("axis conversion", () => {
  it("maps IFC Z-up to render Y-up, as measured against the engine", () => {
    // Determined empirically: an element placed at IFC (10, 20, 5) lands at
    // render (10, 5, -20). See the note in federation.ts.
    expect(ifcToRender([10, 20, 5])).toEqual([10, 5, -20]);
  });

  it("round-trips", () => {
    const v: Vec3 = [1, -2, 3];
    expect(renderToIfc(ifcToRender(v))).toEqual(v);
  });
});

describe("map position of the render origin", () => {
  it("is the map conversion origin when there is no RTC shift", () => {
    expect(
      mapPositionOfRenderOrigin(model("a", georeferenced(-40000, 180000, 190))),
    ).toEqual([-40000, 180000, 190]);
  });

  it("accounts for the engine's RTC shift", () => {
    // originShift is in the render frame; IFC (100, 200, 5) → render (100, 5, -200).
    const shifted = model("a", georeferenced(-40000, 180000, 190), [100, 5, -200]);
    const position = mapPositionOfRenderOrigin(shifted)!;

    expect(position[0]).toBeCloseTo(-40000 + 100, 6);
    expect(position[1]).toBeCloseTo(180000 + 200, 6);
    expect(position[2]).toBeCloseTo(190 + 5, 6);
  });

  it("applies the grid rotation from XAxisAbscissa/XAxisOrdinate", () => {
    // 90° rotation: IFC +x points along map north.
    const rotated = model(
      "a",
      georeferenced(0, 0, 0, { xAxisAbscissa: 0, xAxisOrdinate: 1 }),
      [10, 0, 0],
    );
    const position = mapPositionOfRenderOrigin(rotated)!;
    expect(position[0]).toBeCloseTo(0, 6);
    expect(position[1]).toBeCloseTo(10, 6);
  });

  it("normalises a non-unit axis direction rather than scaling by it", () => {
    // A file writing (2, 0) means "along +x", not "twice as far".
    const sloppy = model(
      "a",
      georeferenced(0, 0, 0, { xAxisAbscissa: 2, xAxisOrdinate: 0 }),
      [10, 0, 0],
    );
    expect(mapPositionOfRenderOrigin(sloppy)![0]).toBeCloseTo(10, 6);
  });

  it("honours the map conversion scale", () => {
    const scaled = model("a", georeferenced(0, 0, 0, { scale: 2 }), [10, 0, 0]);
    expect(mapPositionOfRenderOrigin(scaled)![0]).toBeCloseTo(20, 6);
  });

  it("is null without a map conversion", () => {
    expect(mapPositionOfRenderOrigin(model("a", UNREFERENCED))).toBeNull();
  });

  it("reads the grid rotation angle", () => {
    const rotated = model(
      "a",
      georeferenced(0, 0, 0, {
        xAxisAbscissa: Math.cos(Math.PI / 6),
        xAxisOrdinate: Math.sin(Math.PI / 6),
      }),
    );
    expect(gridRotationAngle(rotated)).toBeCloseTo(Math.PI / 6, 6);
  });
});

describe("world origin", () => {
  it("prefers the first georeferenced model", () => {
    const origin = deriveWorldOrigin([
      model("plain", UNREFERENCED),
      model("geo", georeferenced(-40000, 180000, 190)),
    ]);

    expect(origin.source).toBe("mapConversion");
    expect(origin.derivedFrom).toBe("geo");
    expect(origin.mapPosition).toEqual([-40000, 180000, 190]);
    expect(origin.crs).toBe("EPSG:3763");
  });

  it("falls back to an IfcSite location", () => {
    const sited: FederationModelInput = {
      id: "sited",
      name: "sited",
      coordinates: coordinates(),
      georeference: {
        hasGeoreference: true,
        source: "siteLocation",
        site: { latitude: 41.55, longitude: -8.42 },
      },
    };
    expect(deriveWorldOrigin([model("plain", UNREFERENCED), sited]).source).toBe(
      "siteLocation",
    );
  });

  it("falls back to the first model when nothing is georeferenced", () => {
    const origin = deriveWorldOrigin([
      model("first", UNREFERENCED),
      model("second", UNREFERENCED),
    ]);
    expect(origin.source).toBe("firstModel");
    expect(origin.derivedFrom).toBe("first");
    expect(origin.mapPosition).toBeUndefined();
  });

  it("takes a manual origin over anything derived", () => {
    const origin = deriveWorldOrigin(
      [model("geo", georeferenced(-40000, 180000))],
      { mapPosition: [0, 0, 0], crs: "EPSG:3763" },
    );
    expect(origin.source).toBe("manual");
  });
});

describe("placements", () => {
  it("aligns two georeferenced models by their map separation", () => {
    // 100 m east and 50 m north of the first.
    const models = [
      model("a", georeferenced(-40000, 180000, 190)),
      model("b", georeferenced(-39900, 180050, 195)),
    ];
    const [a, b] = computePlacements(models, deriveWorldOrigin(models));

    expect(a.offset).toEqual([0, 0, 0]);
    expect(a.confidence).toBe("exact");

    // Map (E, N, H) → render (x, y, z) = (E, H, −N).
    expect(b.offset[0]).toBeCloseTo(100, 6);
    expect(b.offset[1]).toBeCloseTo(5, 6);
    expect(b.offset[2]).toBeCloseTo(-50, 6);
    expect(b.confidence).toBe("exact");
  });

  it("aligns models whose RTC shifts differ", () => {
    // Same real-world spot, but the engine shifted them differently.
    const models = [
      model("a", georeferenced(-40000, 180000, 0), [0, 0, 0]),
      model("b", georeferenced(-40000, 180000, 0), [500, 0, -300]),
    ];
    const [, b] = computePlacements(models, deriveWorldOrigin(models));

    // b's render origin is 500 m east and 300 m north of a's, so to bring them
    // together b must move by exactly that.
    expect(b.offset[0]).toBeCloseTo(500, 6);
    expect(b.offset[2]).toBeCloseTo(-300, 6);
  });

  it("reports a rotated model's counter-rotation", () => {
    const models = [
      model("a", georeferenced(0, 0, 0)),
      model(
        "b",
        georeferenced(0, 0, 0, {
          xAxisAbscissa: Math.cos(Math.PI / 4),
          xAxisOrdinate: Math.sin(Math.PI / 4),
        }),
      ),
    ];
    const [, b] = computePlacements(models, deriveWorldOrigin(models));
    expect(b.rotationY).toBeCloseTo(-Math.PI / 4, 6);
  });

  it("marks a model with no georeferencing as unaligned rather than guessing", () => {
    const models = [
      model("geo", georeferenced(-40000, 180000)),
      model("plain", UNREFERENCED),
    ];
    const [, plain] = computePlacements(models, deriveWorldOrigin(models));

    expect(plain.confidence).toBe("unaligned");
    expect(plain.offset).toEqual([0, 0, 0]);
    expect(plain.reason).toMatch(/may not line up/i);
  });

  it("flags a CRS mismatch instead of silently mixing coordinate systems", () => {
    const models = [
      model("a", georeferenced(-40000, 180000, 0, {}, "EPSG:3763")),
      model("b", georeferenced(500000, 4600000, 0, {}, "EPSG:32629")),
    ];
    const [, b] = computePlacements(models, deriveWorldOrigin(models));

    expect(b.confidence).toBe("approximate");
    expect(b.reason).toContain("EPSG:32629");
    expect(b.reason).toMatch(/not reprojected/i);
  });

  it("adds a manual offset on top of the derived placement", () => {
    const models: FederationModelInput[] = [
      model("a", georeferenced(-40000, 180000)),
      { ...model("b", georeferenced(-39900, 180000)), manualOffset: [1, 2, 3] },
    ];
    const [, b] = computePlacements(models, deriveWorldOrigin(models));

    expect(b.offset[0]).toBeCloseTo(101, 6);
    expect(b.offset[1]).toBeCloseTo(2, 6);
    expect(b.offset[2]).toBeCloseTo(3, 6);
    expect(b.reason).toMatch(/manual offset applied/i);
  });

  it("keeps every model when none is georeferenced", () => {
    const models = [model("a", UNREFERENCED), model("b", UNREFERENCED)];
    const placements = computePlacements(models, deriveWorldOrigin(models));

    expect(placements).toHaveLength(2);
    expect(placements[0].confidence).toBe("approximate");
    expect(placements[1].confidence).toBe("unaligned");
  });
});

describe("federated bounds", () => {
  it("unions the placed models", () => {
    const bounds = federatedBounds([
      { bounds: { min: [0, 0, 0], max: [10, 5, 10] }, offset: [0, 0, 0] },
      { bounds: { min: [0, 0, 0], max: [10, 5, 10] }, offset: [100, 0, 0] },
    ])!;

    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([110, 5, 10]);
  });

  it("is null with nothing loaded", () => {
    expect(federatedBounds([])).toBeNull();
  });
});
