import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  orthographicPlanes,
  perspectiveDistance,
  perspectiveFitDistance,
  perspectiveViewHeight,
  standardViewDirection,
} from "../camera";

describe("viewer camera projections", () => {
  it("preserves visible height across perspective and orthographic projection", () => {
    const height = perspectiveViewHeight(25, 60);
    expect(perspectiveDistance(height, 60)).toBeCloseTo(25, 10);
  });

  it("keeps the vertical span and adapts the horizontal span to the viewport", () => {
    expect(orthographicPlanes(20, 16 / 9)).toEqual({
      left: -(160 / 9),
      right: 160 / 9,
      top: 10,
      bottom: -10,
    });
  });

  it("maps building views onto the renderer's Y-up frame", () => {
    expect(standardViewDirection("top")).toEqual([0, 1, 0]);
    expect(standardViewDirection("front")).toEqual([0, 0, 1]);
    expect(standardViewDirection("right")).toEqual([1, 0, 0]);
  });
});

describe("perspective model fitting", () => {
  for (const aspect of [320 / 650, 390 / 690, 844 / 240, 1]) {
    it(`keeps a model's bounding box inside the viewport at aspect ${aspect}`, () => {
      const radius = Math.hypot(10, 4, 8) / 2;
      const camera = new PerspectiveCamera(60, aspect, 0.01, 1000);
      camera.position.copy(new Vector3(1, 0.8, 1).normalize().multiplyScalar(perspectiveFitDistance(radius, 60, aspect)));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      for (const x of [-5, 5]) for (const y of [-2, 2]) for (const z of [-4, 4]) {
        const projected = new Vector3(x, y, z).project(camera);
        expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(projected.z)).toBeLessThanOrEqual(1);
      }
    });
  }
});
