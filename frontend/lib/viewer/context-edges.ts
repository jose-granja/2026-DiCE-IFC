import type { ContextFeatureRange } from "@/lib/georef/context-geometry";
import { featureEdgeMasks } from "./edges";

/** Context is already an unindexed triangle soup, as the edge shader requires. */
export function contextEdgeMasks(positions: Float32Array, ranges: readonly ContextFeatureRange[]): Uint8Array {
  const vertices = positions.length / 3;
  const groups = new Int32Array(vertices / 3).fill(-1);
  for (const range of ranges) groups.fill(range.featureIndex, range.firstTriangle, range.firstTriangle + range.triangleCount);
  const indices = Uint32Array.from({ length: vertices }, (_, i) => i);
  const triangles = featureEdgeMasks(positions, indices, undefined, groups);
  const masks = new Uint8Array(vertices);
  for (let triangle = 0; triangle < triangles.length; triangle++) masks.fill(triangles[triangle], triangle * 3, triangle * 3 + 3);
  return masks;
}
