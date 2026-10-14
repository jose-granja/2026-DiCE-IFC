import { Quaternion, Vector3 } from "three";
import type { Camera } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Vec3 } from "@/lib/ifc/types";

/**
 * Orbit about a picked world point without aiming the camera at it first.
 * OrbitControls still owns gestures, damping, pan and zoom. After it rotates
 * about its view target, translate position and target by (R - I)(target -
 * pivot). This is the same rigid rotation about the picked point, so that
 * point stays under the cursor even when it is away from the screen centre.
 */
export class OrbitPivot {
  private pivot: Vector3 | null = null;
  private previousRotation = new Quaternion();
  private rotation = new Quaternion();
  private offset = new Vector3();
  private translation = new Vector3();

  constructor(private controls: OrbitControls<Camera>) {
    this.previousRotation.copy(controls.object.quaternion);
    controls.addEventListener("change", this.apply);
  }

  get point(): Vec3 | null {
    return this.pivot ? this.pivot.toArray() as Vec3 : null;
  }

  /** Setting a pivot only changes future orbits, never the current view. */
  set(point: Vec3 | null) {
    this.pivot = point && point.every(Number.isFinite) ? new Vector3(...point) : null;
    this.previousRotation.copy(this.controls.object.quaternion);
  }

  /** Also correct the tiny damping steps below OrbitControls' change threshold. */
  update() {
    this.controls.update();
    this.apply();
  }

  private apply = () => {
    const camera = this.controls.object;
    if (this.pivot) {
      this.rotation.copy(this.previousRotation).invert().premultiply(camera.quaternion);
      this.offset.copy(this.controls.target).sub(this.pivot);
      this.translation.copy(this.offset).applyQuaternion(this.rotation).sub(this.offset);
      this.controls.target.add(this.translation);
      camera.position.add(this.translation);
      // Picking and overlays may run before the next WebGL render.
      camera.updateMatrixWorld();
    }
    this.previousRotation.copy(camera.quaternion);
  };

  dispose() {
    this.controls.removeEventListener("change", this.apply);
  }
}
