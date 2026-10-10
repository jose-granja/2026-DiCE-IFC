import { describe, expect, it } from "vitest";

import { placePointCloud, suggestFrame } from "../place";
import type { ModelPlacement, WorldOrigin } from "@/lib/viewer/federation";

const worldOrigin: WorldOrigin = { source: "mapConversion", mapPosition: [-40_000, 180_000, 100] };

const placement = (patch: Partial<ModelPlacement> = {}): ModelPlacement => ({
  modelId: "m",
  offset: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  confidence: "exact",
  reason: "",
  ...patch,
});

describe("placing a point cloud", () => {
  it("puts a map-frame cloud where a georeferenced model at the same coordinates would be", () => {
    const result = placePointCloud({
      origin: [-39_990, 180_020, 105],
      frame: "map",
      worldOrigin,
      model: null,
    });
    expect(result).toEqual({
      ok: true,
      // 10 m east, 5 m up, 20 m north = −20 on the scene's z axis.
      transform: { offset: [10, 5, -20], rotationY: 0, scale: 1 },
    });
  });

  it("cannot place a map-frame cloud without a map position to measure from", () => {
    expect(
      placePointCloud({
        origin: [1, 2, 3],
        frame: "map",
        worldOrigin: { source: "firstModel" },
        model: null,
      }),
    ).toEqual({ ok: false, reason: "no-world-origin" });
  });

  it("moves, turns and scales a model-frame cloud exactly as the model is", () => {
    // A cloud origin 10 m along the model's x axis, in a model turned a quarter turn.
    const result = placePointCloud({
      origin: [10, 0, 0],
      frame: "model",
      worldOrigin,
      model: {
        originShift: [0, 0, 0],
        placement: placement({ offset: [100, 0, 200], rotationY: Math.PI / 2, scale: 2 }),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { offset, rotationY, scale } = result.transform;
    // x = 10 turned by 90° about Y lands on −z, doubled by the scale.
    expect(offset[0]).toBeCloseTo(100, 6);
    expect(offset[1]).toBeCloseTo(0, 6);
    expect(offset[2]).toBeCloseTo(200 - 20, 6);
    expect(rotationY).toBeCloseTo(Math.PI / 2, 9);
    expect(scale).toBe(2);
  });

  it("removes the model's own re-centring shift before placing", () => {
    const result = placePointCloud({
      origin: [5, 0, 0],
      frame: "model",
      worldOrigin: null,
      model: { originShift: [5, 0, 0], placement: placement() },
    });
    expect(result).toEqual({ ok: true, transform: { offset: [0, 0, 0], rotationY: 0, scale: 1 } });
  });

  it("falls back to the scene origin for a model with no placement", () => {
    const result = placePointCloud({
      origin: [1, 2, 3],
      frame: "model",
      worldOrigin: null,
      model: { originShift: [0, 0, 0], placement: null },
    });
    // IFC (1, 2, 3) → scene (1, 3, −2).
    expect(result).toEqual({ ok: true, transform: { offset: [1, 3, -2], rotationY: 0, scale: 1 } });
  });

  it("suggests the map frame only when it is plausible and possible", () => {
    expect(suggestFrame([170_000, 4_650_000, 80], worldOrigin)).toBe("map");
    expect(suggestFrame([12, 8, 0], worldOrigin)).toBe("model");
    expect(suggestFrame([170_000, 4_650_000, 80], null)).toBe("model");
  });
});
