"use client";

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { chooseViewDirection } from "./view";
import type { ClashResultItem, Vec3 } from "./types";

/**
 * The box to frame for a clash and the side to look at it from: room around
 * where the elements meet (not the whole of two long elements, which would
 * make a pipe through a 30 m wall a speck), seen from a side where neither
 * element hides the other.
 */
export function clashView(item: ClashResultItem): {
  bounds: { min: Vec3; max: Vec3 };
  direction: Vec3 | undefined;
} {
  const pad = Math.max(0.75, Math.hypot(...item.extent) * 1.5);
  const bounds = {
    min: [item.min[0] - pad, item.min[1] - pad, item.min[2] - pad] as Vec3,
    max: [item.max[0] + pad, item.max[1] + pad, item.max[2] + pad] as Vec3,
  };

  const renderer = getActiveRenderer();
  const meshes = [item.elementA, item.elementB]
    .map((element) => renderer?.getElementWorldGeometry(element))
    .filter((mesh): mesh is NonNullable<typeof mesh> => Boolean(mesh));
  const direction =
    meshes.length > 0 ? chooseViewDirection(item.point, pad * 4, meshes) : undefined;

  return { bounds, direction };
}
