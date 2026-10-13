"use client";

/**
 * The point clouds loaded into the viewer.
 *
 * Separate from the model store on purpose. A point cloud is a reference to
 * compare the model against, not a model: it has no entities, no spatial tree,
 * no properties and takes no part in IDS validation, clash detection or the
 * federation bounds. Keeping it out of `useViewerStore` means none of those
 * ever has to remember to skip it.
 *
 * The decoded arrays live here by reference — they are tens to hundreds of
 * megabytes, and a store that copied or serialised them would be the end of the
 * tab. Nothing here is persisted.
 */

import { create } from "zustand";

import type { PointColourMode } from "@/lib/pointcloud/colour";
import type { DecodedPointCloud } from "@/lib/pointcloud/decode";
import type { PointCloudFormat } from "@/lib/pointcloud/formats";
import type { CloudFrame } from "@/lib/pointcloud/place";

export type PointCloudEntry = {
  id: string;
  name: string;
  format: PointCloudFormat;
  bytes: number;
  status: "loading" | "ready" | "failed";
  /** 0–1 while loading. */
  progress: number;
  error?: string;
  /** Set once `status` is `ready`. */
  cloud: DecodedPointCloud | null;
  /** How its coordinates are read — see `lib/pointcloud/place.ts`. */
  frame: CloudFrame;
  mode: PointColourMode;
  /** Point size in pixels. */
  size: number;
  visible: boolean;
};

type PointCloudState = {
  clouds: PointCloudEntry[];
  /**
   * Edge shading (eye-dome lighting) for every cloud — the darkened depth steps
   * and silhouette halo that make a scan without normals read as a shape. On by
   * default, as on ifclite.com; one setting for the scene, not per cloud.
   */
  edgeShading: boolean;
  setEdgeShading: (on: boolean) => void;
  add: (entry: PointCloudEntry) => void;
  update: (id: string, patch: Partial<PointCloudEntry>) => void;
  remove: (id: string) => void;
  clear: () => void;
};

/** Pixels. Large enough that the edge shading has a surface to work across. */
export const DEFAULT_POINT_SIZE = 4;

export const usePointCloudStore = create<PointCloudState>((set) => ({
  clouds: [],
  edgeShading: true,
  setEdgeShading: (edgeShading) => set({ edgeShading }),
  add: (entry) => set((state) => ({ clouds: [...state.clouds, entry] })),
  update: (id, patch) =>
    set((state) => ({
      clouds: state.clouds.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    })),
  remove: (id) => set((state) => ({ clouds: state.clouds.filter((entry) => entry.id !== id) })),
  clear: () => set({ clouds: [] }),
}));
