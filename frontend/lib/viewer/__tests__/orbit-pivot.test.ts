import { describe, expect, it } from "vitest";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OrbitPivot } from "../orbit-pivot";

function setup(orthographic = false) {
  const camera = orthographic
    ? new OrthographicCamera(-12, 12, 9, -9, 0.1, 1000)
    : new PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.position.set(12, 8, 15);
  const controls = new OrbitControls(camera);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  const pivot = new OrbitPivot(controls);
  const point = new Vector3(4, 2, 1);
  const project = () => {
    camera.updateMatrixWorld();
    return point.clone().project(camera);
  };
  return { camera, controls, pivot, point, project };
}

describe("picked rotation point", () => {
  for (const orthographic of [false, true]) {
    it(`keeps an off-centre point fixed throughout ${orthographic ? "orthographic" : "perspective"} rotation and damping`, () => {
      const { camera, controls, pivot, point, project } = setup(orthographic);
      const before = project();
      const position = camera.position.clone();
      const distance = camera.position.distanceTo(point);
      pivot.set(point.toArray());

      controls.rotateLeft(0.7);
      controls.rotateUp(-0.3);
      for (let frame = 0; frame < 180; frame++) {
        pivot.update();
        expect(project().distanceTo(before)).toBeLessThan(0.0001);
        expect(camera.position.distanceTo(point)).toBeCloseTo(distance, 4);
      }
      expect(camera.position.distanceTo(position)).toBeGreaterThan(5);
      pivot.dispose();
    });
  }

  it("changes the rotation point without jumping or aiming at it", () => {
    const { camera, controls, pivot } = setup();
    const position = camera.position.clone();
    const target = controls.target.clone();
    const rotation = camera.quaternion.clone();
    pivot.set([4, 2, 1]);
    pivot.set([-3, 1, 2]);
    pivot.update();
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-10);
    expect(controls.target.distanceTo(target)).toBeLessThan(1e-10);
    expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
    pivot.dispose();
  });

  it("preserves pan and zoom while retaining the picked world point", () => {
    const { camera, controls, pivot, point } = setup();
    pivot.set(point.toArray());
    const translation = new Vector3(2, 3, 0);
    controls.target.add(translation);
    camera.position.add(translation);
    pivot.update();
    expect(controls.target.distanceTo(translation)).toBeLessThan(1e-10);
    const distance = camera.position.distanceTo(controls.target);
    controls.dollyIn(0.8);
    expect(camera.position.distanceTo(controls.target)).not.toBeCloseTo(distance);
    expect(pivot.point).toEqual(point.toArray());
    pivot.dispose();
  });

  it("clears the previous pivot before restoring a camera or fitting the view", () => {
    const { camera, controls, pivot } = setup();
    pivot.set([4, 2, 1]);
    controls.rotateLeft(0.2);
    for (let frame = 0; frame < 180; frame++) pivot.update();
    pivot.set(null);
    camera.position.set(0, 0, 20);
    controls.target.set(0, 0, 0);
    pivot.update();
    expect(pivot.point).toBeNull();
    expect(camera.position.distanceTo(new Vector3(0, 0, 20))).toBeLessThan(1e-6);
    expect(controls.target.length()).toBeLessThan(1e-10);
    pivot.dispose();
  });
});
