import { countSegmentCrossings } from "./geometry";
import type { Vec3 } from "./types";

/** Eight compass points at two heights, each as a direction from the target. */
const CANDIDATES: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (const elevation of [0.6, 1.4]) {
    for (let k = 0; k < 8; k += 1) {
      const angle = (k / 8) * Math.PI * 2;
      out.push([Math.cos(angle), elevation, Math.sin(angle)]);
    }
  }
  return out;
})();

/**
 * Where to put a camera so a clash can be seen.
 *
 * Looking at two elements from the wrong side is common: a pipe a hand's width
 * from a wall is simply not in the picture from the wall's far side. Each
 * candidate camera position is tried, counting how many surfaces of the two
 * elements lie between it and the point of interest; the one with the fewest
 * wins, and ties keep the earlier (lower, more natural) candidate.
 */
export function chooseViewDirection(
  target: Vec3,
  distance: number,
  meshes: Array<{ positions: Float32Array; indices: Uint32Array }>,
): Vec3 {
  let best = CANDIDATES[0];
  let bestCrossings = Infinity;
  for (const candidate of CANDIDATES) {
    const length = Math.hypot(...candidate);
    const position: Vec3 = [
      target[0] + (candidate[0] / length) * distance,
      target[1] + (candidate[1] / length) * distance,
      target[2] + (candidate[2] / length) * distance,
    ];
    const crossings = countSegmentCrossings(position, target, meshes);
    if (crossings < bestCrossings) {
      best = candidate;
      bestCrossings = crossings;
      if (crossings === 0) break;
    }
  }
  return best;
}
