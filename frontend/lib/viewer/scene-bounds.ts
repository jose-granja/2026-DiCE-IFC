"use client";

/**
 * Everything a tool can work on: the models, and the point clouds and context
 * model around them.
 *
 * Not the federation bounds, which are the models alone on purpose — a scan or
 * someone else's city must not move the federation, frame "Fit view" or count
 * in validation (AGENTS.md §8b, §8c). But a section plane through a scan, or a
 * measurement on a neighbouring building, is exactly what those are loaded for,
 * so the section tools size themselves on this instead.
 */

import type { Vec3 } from "@/lib/ifc/types";
import { getActiveRenderer } from "./active-renderer";
import { useViewerStore } from "./store";

type Box = { min: Vec3; max: Vec3 };

export function unionBounds(boxes: Array<Box | null | undefined>): Box | null {
  let result: Box | null = null;
  for (const box of boxes) {
    if (!box) continue;
    result = result
      ? {
          min: [0, 1, 2].map((axis) => Math.min(result!.min[axis], box.min[axis])) as Vec3,
          max: [0, 1, 2].map((axis) => Math.max(result!.max[axis], box.max[axis])) as Vec3,
        }
      : { min: [...box.min] as Vec3, max: [...box.max] as Vec3 };
  }
  return result;
}

export function sceneBounds(): Box | null {
  const renderer = getActiveRenderer();
  return unionBounds([
    useViewerStore.getState().federationBounds(),
    renderer?.getPointCloudBounds(),
    renderer?.getContextBounds(),
  ]);
}
