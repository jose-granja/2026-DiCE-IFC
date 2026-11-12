import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { Vec3 } from "@/lib/ifc/types";

import { anchorAtTargetDepth, scaleAbout, wheelZoomFactor } from "../cursor-zoom";

const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => ({ deltaY, deltaMode, ctrlKey });

describe("wheelZoomFactor", () => {
  it("brings the camera closer on wheel up, further on wheel down, by the same step", () => {
    const closer = wheelZoomFactor(wheel(-100));
    expect(closer).toBeCloseTo(0.95);
    expect(wheelZoomFactor(wheel(100))).toBeCloseTo(1 / 0.95);
    expect(wheelZoomFactor(wheel(0))).toBe(1);
  });

  it("reads lines and pages as OrbitControls does, and a pinch as ten scrolls", () => {
    expect(wheelZoomFactor(wheel(-1, 1))).toBeCloseTo(wheelZoomFactor(wheel(-16)));
    expect(wheelZoomFactor(wheel(-1, 2))).toBeCloseTo(wheelZoomFactor(wheel(-100)));
    expect(wheelZoomFactor(wheel(-2, 0, true))).toBeCloseTo(wheelZoomFactor(wheel(-20)));
  });
});

describe("scaleAbout", () => {
  it("keeps the anchor where it is on screen", () => {
    const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
    camera.position.set(10, 8, 12);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    // A point off to one side of the view, not the target.
    const anchor: Vec3 = [3, 1, -2];
    const before = new THREE.Vector3(...anchor).project(camera);

    const position = scaleAbout(camera.position.toArray() as Vec3, anchor, 0.5);
    const target = scaleAbout([0, 0, 0], anchor, 0.5);
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
    const after = new THREE.Vector3(...anchor).project(camera);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // And the camera is half as far from it.
    expect(camera.position.distanceTo(new THREE.Vector3(...anchor))).toBeCloseTo(Math.hypot(7, 7, 14) / 2);
  });
});

describe("anchorAtTargetDepth", () => {
  it("is on the cursor's ray, as deep as the target", () => {
    const anchor = anchorAtTargetDepth([0, 0, 10], [0.6, 0, -0.8], [0, 0, -1], [0, 0, 0])!;
    expect(anchor[2]).toBeCloseTo(0);
    expect(anchor[0]).toBeCloseTo(7.5);
  });

  it("has none when the target is behind or the ray runs sideways", () => {
    expect(anchorAtTargetDepth([0, 0, 10], [0, 0, -1], [0, 0, -1], [0, 0, 20])).toBeNull();
    expect(anchorAtTargetDepth([0, 0, 10], [1, 0, 0], [0, 0, -1], [0, 0, 0])).toBeNull();
  });
});
