/**
 * Frame conversions.
 *
 * A round-trip test on its own is not enough here: a sign error applied in both
 * directions round-trips perfectly and still points the camera at nothing. So
 * the axis mapping and the shift direction are also asserted against explicit
 * hand-computed values, and against the axis convention the rest of the app
 * already established (`render = (x, z, −y)`, and `lib/georef/footprint.ts`
 * for the shift).
 */

import { describe, expect, it } from "vitest";

import type { Vec3 } from "@/lib/ifc/types";
import type { SectionPlane } from "@/lib/viewer/tools";
import {
  IDENTITY_FRAME,
  bcfColour,
  bcfPointToRender,
  cameraFromViewer,
  cameraToViewer,
  clippingPlanesToSections,
  componentPlan,
  cssColour,
  describeViewpoint,
  renderPointToBcf,
  sectionsToClippingPlanes,
  type ViewpointFrame,
} from "../viewpoint";
import type { BcfCamera, BcfComponents, BcfViewpoint } from "../types";

const FRAME: ViewpointFrame = {
  originShift: [100, 5, -200],
  placementOffset: [10, 0, 20],
};

describe("point conversion", () => {
  it("maps IFC Z-up onto the render frame's Y-up", () => {
    // render = (x, z, −y), the convention established in federation.ts.
    expect(bcfPointToRender([1, 2, 3], IDENTITY_FRAME)).toEqual([1, 3, -2]);
  });

  it("subtracts the RTC shift and adds the placement offset", () => {
    // IFC (100, 200, 5) → render (100, 5, −200); minus the shift is (0, 0, 0);
    // plus the placement is the offset itself.
    expect(bcfPointToRender([100, 200, 5], FRAME)).toEqual([10, 0, 20]);
  });

  it("round-trips a point through both directions", () => {
    const point: Vec3 = [12345.678, -987.65, 43.21];
    const there = bcfPointToRender(point, FRAME);
    const back = renderPointToBcf(there, FRAME);

    back.forEach((value, index) => expect(value).toBeCloseTo(point[index], 9));
  });

  it("never produces -0", () => {
    // -0 serialises as "-0" and reads as a bug in every diff.
    for (const value of bcfPointToRender([0, 0, 0], IDENTITY_FRAME)) {
      expect(Object.is(value, -0)).toBe(false);
    }
  });
});

describe("cameraToViewer", () => {
  const perspective: BcfCamera = {
    kind: "perspective",
    viewPoint: [0, -10, 2],
    direction: [0, 1, 0],
    upVector: [0, 0, 1],
    fieldOfView: 45,
  };

  it("places the camera and puts the target along the view direction", () => {
    const state = cameraToViewer(perspective, IDENTITY_FRAME, 10);

    // IFC (0,-10,2) → render (0, 2, 10). Looking along IFC +Y is render −Z.
    expect(state.position).toEqual([0, 2, 10]);
    expect(state.target[2]).toBeCloseTo(0, 6);
    expect(state.fov).toBe(45);
  });

  it("takes the vertical field of view straight through", () => {
    // Both BCF and three.js mean "vertical, in degrees". Converting would be
    // the bug.
    expect(cameraToViewer(perspective, IDENTITY_FRAME).fov).toBe(45);
  });

  it("frames an orthogonal camera by its view-to-world scale", () => {
    const state = cameraToViewer(
      {
        kind: "orthogonal",
        viewPoint: [0, -10, 2],
        direction: [0, 1, 0],
        upVector: [0, 0, 1],
        viewToWorldScale: 40,
      },
      IDENTITY_FRAME,
    );

    // No fov: the viewer has no orthogonal mode, so claiming one would lie.
    expect(state.fov).toBeUndefined();
    const distance = Math.hypot(
      state.target[0] - state.position[0],
      state.target[1] - state.position[1],
      state.target[2] - state.position[2],
    );
    expect(distance).toBeCloseTo(40, 6);
  });

  it("round-trips a viewer camera through BCF", () => {
    const state = { position: [5, 12, 30] as Vec3, target: [0, 2, 0] as Vec3, fov: 55 };
    const camera = cameraFromViewer(state, FRAME, 16 / 9);
    const back = cameraToViewer(camera, FRAME, 1);

    back.position.forEach((value, index) =>
      expect(value).toBeCloseTo(state.position[index], 6),
    );
    expect(back.fov).toBe(55);

    // The target moves along the same ray, so the direction must survive even
    // though the distance does not.
    const original = normalize(sub(state.target, state.position));
    const restored = normalize(sub(back.target, back.position));
    restored.forEach((value, index) => expect(value).toBeCloseTo(original[index], 6));
  });

  it("writes an up vector perpendicular to the direction", () => {
    const camera = cameraFromViewer(
      { position: [0, 50, 0], target: [0, 0, 0], fov: 60 },
      IDENTITY_FRAME,
      1,
    );

    // Looking straight down: a constant world up would be parallel to the view
    // direction, which some viewers resolve as a 90° roll.
    const alignment =
      camera.direction[0] * camera.upVector[0] +
      camera.direction[1] * camera.upVector[1] +
      camera.direction[2] * camera.upVector[2];
    expect(Math.abs(alignment)).toBeLessThan(1e-6);
  });

  it("always writes a positive aspect ratio, which the schema requires", () => {
    const camera = cameraFromViewer(
      { position: [0, 1, 0], target: [0, 0, 0] },
      IDENTITY_FRAME,
      0,
    );
    expect(camera.aspectRatio).toBeGreaterThan(0);
  });
});

describe("clipping planes", () => {
  it("converts an axis-aligned plane into a section", () => {
    const { planes, skipped } = clippingPlanesToSections(
      [{ location: [0, 0, 3], direction: [0, 0, 1] }],
      IDENTITY_FRAME,
    );

    expect(skipped).toBe(0);
    // IFC +Z is render +Y, so a horizontal cut becomes a y section at 3.
    expect(planes[0].axis).toBe("y");
    expect(planes[0].position).toBe(3);
  });

  it("reports an oblique plane instead of snapping it to an axis", () => {
    const { planes, skipped } = clippingPlanesToSections(
      [{ location: [0, 0, 0], direction: [0.7, 0.7, 0] }],
      IDENTITY_FRAME,
    );

    expect(planes).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("round-trips a section plane", () => {
    const section: SectionPlane = {
      id: "x-1",
      axis: "x",
      position: 12.5,
      flipped: true,
      enabled: true,
    };

    const [converted] = sectionsToClippingPlanes([section], FRAME);
    const { planes } = clippingPlanesToSections([converted], FRAME);

    expect(planes[0].axis).toBe("x");
    expect(planes[0].position).toBeCloseTo(12.5, 6);
    expect(planes[0].flipped).toBe(true);
  });

  it("ignores disabled sections", () => {
    expect(
      sectionsToClippingPlanes(
        [{ id: "y-1", axis: "y", position: 0, flipped: false, enabled: false }],
        IDENTITY_FRAME,
      ),
    ).toEqual([]);
  });
});

describe("componentPlan", () => {
  const components = (patch: Partial<BcfComponents>): BcfComponents => ({
    selection: [],
    defaultVisibility: true,
    exceptions: [],
    coloring: [],
    ...patch,
  });

  it("treats DefaultVisibility=false as an isolation", () => {
    // This is how every "show me just this wall" viewpoint in the official
    // test suite is written, and the inversion is easy to read backwards.
    const plan = componentPlan(
      components({ defaultVisibility: false, exceptions: [{ ifcGuid: "abc" }] }),
    );

    expect(plan.isolate).toEqual(["abc"]);
    expect(plan.hide).toEqual([]);
  });

  it("treats DefaultVisibility=true as a hide list", () => {
    const plan = componentPlan(
      components({ defaultVisibility: true, exceptions: [{ ifcGuid: "abc" }] }),
    );

    expect(plan.isolate).toBeNull();
    expect(plan.hide).toEqual(["abc"]);
  });

  it("flattens colouring into one entry per element", () => {
    const plan = componentPlan(
      components({
        coloring: [
          { colour: "FF0000", components: [{ ifcGuid: "a" }, { ifcGuid: "b" }] },
        ],
      }),
    );

    expect(plan.colouring).toEqual([
      { ifcGuid: "a", colour: "#ff0000" },
      { ifcGuid: "b", colour: "#ff0000" },
    ]);
  });

  it("drops components with no IfcGuid", () => {
    const plan = componentPlan(
      components({ selection: [{ ifcGuid: "a" }, { originatingSystem: "x" }] }),
    );
    expect(plan.select).toEqual(["a"]);
  });

  it("copes with a viewpoint that has no components", () => {
    expect(componentPlan(null)).toEqual({
      select: [],
      isolate: null,
      hide: [],
      colouring: [],
    });
  });
});

describe("colours", () => {
  it("round-trips through CSS", () => {
    expect(cssColour("FF8800")).toBe("#ff8800");
    expect(bcfColour("#ff8800")).toBe("FF8800");
  });

  it("keeps an alpha channel", () => {
    expect(cssColour("FF880080")).toBe("#ff880080");
  });

  it("expands CSS shorthand, which BCF has no form for", () => {
    expect(bcfColour("#f80")).toBe("FF8800");
  });

  it("falls back rather than emitting something invalid", () => {
    expect(cssColour("nonsense")).toBe("#ff00ff");
    expect(bcfColour("nonsense")).toBe("FF00FF");
  });
});

describe("describeViewpoint", () => {
  it("summarises what opening it will do", () => {
    const viewpoint: BcfViewpoint = {
      guid: "v1",
      fileName: "v1.bcfv",
      camera: {
        kind: "perspective",
        viewPoint: [0, 0, 0],
        direction: [0, 1, 0],
        upVector: [0, 0, 1],
        fieldOfView: 60,
      },
      components: {
        selection: [{ ifcGuid: "a" }],
        defaultVisibility: false,
        exceptions: [{ ifcGuid: "a" }, { ifcGuid: "b" }],
        coloring: [],
      },
      clippingPlanes: [],
      lines: [],
      bitmaps: [],
    };

    expect(describeViewpoint(viewpoint)).toBe(
      "perspective camera, 1 selected, 2 isolated",
    );
  });

  it("says so when there is nothing to restore", () => {
    expect(
      describeViewpoint({
        guid: "v",
        fileName: "v.bcfv",
        camera: null,
        components: null,
        clippingPlanes: [],
        lines: [],
        bitmaps: [],
      }),
    ).toBe("no camera or components");
  });
});

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}
