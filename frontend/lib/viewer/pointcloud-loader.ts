"use client";

/**
 * Open point-cloud files in the viewer.
 *
 * Each file appears in the list at once, in a `loading` state with a progress
 * figure, and is decoded in a worker (`lib/workers/pointcloud.worker.ts`). The
 * file is read in the tab and never uploaded — the same rule as every other
 * format here (AGENTS.md §1).
 */

import { pointCloudFormat } from "@/lib/pointcloud/formats";
import { defaultMode } from "@/lib/pointcloud/colour";
import { suggestFrame } from "@/lib/pointcloud/place";
import { loadPointCloud, type PointCloudLoad } from "@/lib/workers/pointcloud-client";

import { DEFAULT_POINT_SIZE, usePointCloudStore, type PointCloudEntry } from "./pointcloud-store";

const jobs = new Map<string, PointCloudLoad>();

let counter = 0;

/** The file each cloud was opened from, for saving it into a project folder. */
const sources = new Map<string, File>();

export function getPointCloudSource(id: string): File | undefined {
  return sources.get(id);
}

/** What a project folder remembers about a cloud, applied once it has decoded. */
export type PointCloudPreset = Partial<Pick<PointCloudEntry, "frame" | "mode" | "size" | "visible">>;

export type PointCloudOutcome =
  | { file: string; ok: true; cloudId: string }
  | { file: string; ok: false; error: string };

/** Load one file. Resolves when it is on screen or has failed; never rejects. */
export async function loadPointCloudFile(
  file: File,
  preset: PointCloudPreset = {},
): Promise<PointCloudOutcome> {
  const format = pointCloudFormat(file.name);
  if (!format) {
    return { file: file.name, ok: false, error: "Not a supported point-cloud file." };
  }

  const id = `pointcloud-${Date.now().toString(36)}-${(counter += 1)}`;
  const store = usePointCloudStore.getState();
  sources.set(id, file);
  store.add({
    id,
    name: file.name,
    format,
    bytes: file.size,
    status: "loading",
    progress: 0,
    cloud: null,
    frame: "model",
    mode: "flat",
    size: preset.size ?? DEFAULT_POINT_SIZE,
    visible: preset.visible ?? true,
  });

  const job = loadPointCloud(file, {
    onProgress: (done, total) => {
      usePointCloudStore.getState().update(id, { progress: total > 0 ? done / total : 0 });
    },
  });
  jobs.set(id, job);

  try {
    const cloud = await job.done;
    usePointCloudStore.getState().update(id, {
      status: "ready",
      progress: 1,
      cloud,
      // A preset is what the user chose last time; the suggestion is only a
      // guess from the coordinates' magnitude, so the choice wins.
      mode: preset.mode ?? defaultMode(cloud),
      frame: preset.frame ?? suggestFrame(cloud.origin),
    });
    return { file: file.name, ok: true, cloudId: id };
  } catch (error) {
    // Cancelling removes the entry first; there is nothing left to mark.
    if (!usePointCloudStore.getState().clouds.some((entry) => entry.id === id)) {
      return { file: file.name, ok: false, error: "Cancelled." };
    }
    const message = error instanceof Error ? error.message : String(error);
    usePointCloudStore.getState().update(id, { status: "failed", error: message });
    return { file: file.name, ok: false, error: message };
  } finally {
    jobs.delete(id);
  }
}

/** Remove a cloud, stopping its decode if it is still running. */
export function removePointCloud(id: string) {
  jobs.get(id)?.cancel();
  jobs.delete(id);
  sources.delete(id);
  usePointCloudStore.getState().remove(id);
}
