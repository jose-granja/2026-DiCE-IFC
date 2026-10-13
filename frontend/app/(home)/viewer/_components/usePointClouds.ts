"use client";

/**
 * Make the scene's point clouds a function of the point-cloud store.
 *
 * The same arrangement as models in `ViewerCanvas`: the loader and the list
 * only ever touch the store, and this is the one place that touches the
 * renderer — so a cloud removed from the list cannot stay drawn, and one that
 * survives a visit to another page is drawn again by the new renderer.
 */

import { useEffect, useRef, type RefObject } from "react";

import { buildColours, type PointColourMode } from "@/lib/pointcloud/colour";
import type { DecodedPointCloud } from "@/lib/pointcloud/decode";
import { usePointCloudStore } from "@/lib/viewer/pointcloud-store";
import { resolveCloudTransform } from "@/lib/viewer/pointcloud-placement";
import type { ViewerRenderer } from "@/lib/viewer/renderer";
import { useViewerStore } from "@/lib/viewer/store";

type Applied = {
  cloud: DecodedPointCloud;
  mode: PointColourMode;
  size: number;
  visible: boolean;
  transform: string;
};

export function usePointClouds(rendererRef: RefObject<ViewerRenderer | null>, ready: boolean) {
  const clouds = usePointCloudStore((state) => state.clouds);
  const edgeShading = usePointCloudStore((state) => state.edgeShading);
  const models = useViewerStore((state) => state.models);
  const placements = useViewerStore((state) => state.placements);
  const worldOrigin = useViewerStore((state) => state.worldOrigin);

  // What the renderer currently holds, so a change redoes only what changed.
  const applied = useRef(new Map<string, Applied>());
  // A new renderer starts empty, whatever this remembers.
  const lastRenderer = useRef<ViewerRenderer | null>(null);

  // A scene-wide setting, so it is applied on its own — and again to a new renderer.
  useEffect(() => {
    if (ready) rendererRef.current?.setPointCloudEdgeShading(edgeShading);
  }, [edgeShading, ready, rendererRef]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!ready || !renderer) return;

    if (lastRenderer.current !== renderer) {
      applied.current.clear();
      lastRenderer.current = renderer;
    }

    const live = new Set(clouds.map((entry) => entry.id));
    for (const id of [...applied.current.keys()]) {
      if (live.has(id)) continue;
      renderer.removePointCloud(id);
      applied.current.delete(id);
    }

    const viewer = { models, placements, worldOrigin };
    for (const entry of clouds) {
      const cloud = entry.cloud;
      if (entry.status !== "ready" || !cloud) continue;

      const { transform } = resolveCloudTransform(entry, viewer);
      const transformKey = JSON.stringify(transform);
      const before = applied.current.get(entry.id);

      if (!before || before.cloud !== cloud) {
        renderer.addPointCloud(
          entry.id,
          { positions: cloud.positions, colours: buildColours(entry.mode, cloud) },
          transform.offset,
          entry.size,
        );
        renderer.setPointCloudTransform(entry.id, transform.offset, transform.rotationY, transform.scale);
        renderer.setPointCloudVisible(entry.id, entry.visible);
        // Bring the first thing on screen into view; a cloud added to a scene
        // that already has models leaves the camera where the user put it.
        if (renderer.modelCount === 0 && applied.current.size === 0) {
          renderer.fitToBounds(renderer.getPointCloudBounds(entry.id));
        }
        applied.current.set(entry.id, {
          cloud,
          mode: entry.mode,
          size: entry.size,
          visible: entry.visible,
          transform: transformKey,
        });
        continue;
      }

      if (before.mode !== entry.mode) {
        renderer.setPointCloudColours(entry.id, buildColours(entry.mode, cloud));
        before.mode = entry.mode;
      }
      if (before.size !== entry.size) {
        renderer.setPointCloudSize(entry.id, entry.size);
        before.size = entry.size;
      }
      if (before.visible !== entry.visible) {
        renderer.setPointCloudVisible(entry.id, entry.visible);
        before.visible = entry.visible;
      }
      if (before.transform !== transformKey) {
        renderer.setPointCloudTransform(entry.id, transform.offset, transform.rotationY, transform.scale);
        before.transform = transformKey;
      }
    }
  }, [clouds, models, placements, worldOrigin, ready, rendererRef]);
}
