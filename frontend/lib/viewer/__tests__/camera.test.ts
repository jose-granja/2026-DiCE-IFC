import { describe, expect, it } from "vitest";

import {
  orthographicPlanes,
  perspectiveDistance,
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
