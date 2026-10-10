import type { Vec3 } from "@/lib/ifc/types";

export type CameraProjection = "perspective" | "orthographic";

export type StandardView =
  | "isometric"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "left"
  | "right";

/** Camera position relative to its orbit target for the named building view. */
export function standardViewDirection(view: StandardView): Vec3 {
  switch (view) {
    case "top":
      return [0, 1, 0];
    case "bottom":
      return [0, -1, 0];
    case "front":
      return [0, 0, 1];
    case "back":
      return [0, 0, -1];
    case "left":
      return [-1, 0, 0];
    case "right":
      return [1, 0, 0];
    case "isometric":
      return [1, 0.8, 1];
  }
}

/** Visible vertical span that makes a projection switch keep the same scale. */
export function perspectiveViewHeight(distance: number, fovDegrees: number): number {
  return 2 * distance * Math.tan((fovDegrees * Math.PI) / 360);
}

/** Camera distance that gives a perspective view the requested vertical span. */
export function perspectiveDistance(viewHeight: number, fovDegrees: number): number {
  return viewHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360));
}

/** Symmetric orthographic planes for a vertical span and viewport aspect. */
export function orthographicPlanes(viewHeight: number, aspect: number) {
  const halfHeight = Math.max(viewHeight / 2, 0.0001);
  const halfWidth = halfHeight * Math.max(aspect, 0.0001);
  return {
    left: -halfWidth,
    right: halfWidth,
    top: halfHeight,
    bottom: -halfHeight,
  };
}

