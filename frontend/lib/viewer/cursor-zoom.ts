/**
 * Zooming towards the cursor: the arithmetic, apart from the renderer.
 *
 * OrbitControls dollies towards its target, the middle of the screen, so
 * zooming in on a door at the edge of the view sends it off the screen. Its own
 * `zoomToCursor` steps by the distance to that target rather than to what is
 * under the cursor, so a step towards a near wall goes straight through it.
 * The viewer instead scales the view about a point under the cursor: the
 * camera and its target both move towards it by the same factor, so it stays
 * exactly where it is on screen, and the camera slows as it nears it.
 */

import type { Vec3 } from "@/lib/ifc/types";

type Wheel = { deltaY: number; deltaMode: number; ctrlKey: boolean };

/**
 * What one wheel event multiplies the camera's distance by: below 1 closer
 * (wheel up), above 1 further. OrbitControls' own speed and units, so the
 * wheel feels as it did: lines and pages are 16 and 100 pixels, and a
 * trackpad pinch (a wheel with ctrlKey) ten times a scroll.
 */
export function wheelZoomFactor({ deltaY, deltaMode, ctrlKey }: Wheel, zoomSpeed = 1): number {
  let delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1);
  if (ctrlKey) delta *= 10;
  if (!Number.isFinite(delta) || delta === 0) return 1;
  const step = Math.pow(0.95, zoomSpeed * Math.abs(delta) * 0.01);
  return delta < 0 ? step : 1 / step;
}

/** `point` scaled about `anchor` by `factor`. */
export function scaleAbout(point: Vec3, anchor: Vec3, factor: number): Vec3 {
  return [
    anchor[0] + (point[0] - anchor[0]) * factor,
    anchor[1] + (point[1] - anchor[1]) * factor,
    anchor[2] + (point[2] - anchor[2]) * factor,
  ];
}

/**
 * Where to zoom when nothing is under the cursor: along the cursor's ray
 * (`ray`, unit length, from `position`), as deep as the orbit target is in
 * front of the camera (`forward`, unit length), so the zoom keeps the pace the
 * target set. Null when the target is not in front.
 */
export function anchorAtTargetDepth(position: Vec3, ray: Vec3, forward: Vec3, target: Vec3): Vec3 | null {
  const depth =
    (target[0] - position[0]) * forward[0] +
    (target[1] - position[1]) * forward[1] +
    (target[2] - position[2]) * forward[2];
  const along = ray[0] * forward[0] + ray[1] * forward[1] + ray[2] * forward[2];
  if (!(depth > 0) || !(along > 1e-6)) return null;
  const distance = depth / along;
  return [position[0] + ray[0] * distance, position[1] + ray[1] * distance, position[2] + ray[2] * distance];
}
