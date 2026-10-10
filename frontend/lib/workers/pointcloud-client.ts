"use client";

/**
 * Main-thread handle on the point-cloud decoder.
 *
 * A worker per file, torn down when it finishes: cancelling a half-decoded
 * 2 GB scan has to actually stop it, and `terminate()` is the only way to stop
 * a synchronous decode loop. Spinning a worker up costs milliseconds; the
 * decode it serves costs seconds.
 */

import * as Comlink from "comlink";

import type { DecodedPointCloud } from "@/lib/pointcloud/decode";
import { DEFAULT_MAX_POINTS } from "@/lib/pointcloud/decode";
import { pointCloudFormat } from "@/lib/pointcloud/formats";
import type { PointCloudWorkerApi } from "./pointcloud.worker";

export type PointCloudLoad = {
  /** Resolves with the decoded cloud, or rejects (`AbortError` when cancelled). */
  done: Promise<DecodedPointCloud>;
  cancel: () => void;
};

export function loadPointCloud(
  file: File,
  options: { maxPoints?: number; onProgress?: (done: number, total: number) => void } = {},
): PointCloudLoad {
  const format = pointCloudFormat(file.name);
  if (!format) {
    return {
      done: Promise.reject(new Error(`“${file.name}” is not a supported point-cloud file.`)),
      cancel: () => {},
    };
  }

  const worker = new Worker(new URL("./pointcloud.worker.ts", import.meta.url), {
    type: "module",
  });
  const api = Comlink.wrap<PointCloudWorkerApi>(worker);

  // A terminated worker never answers, so cancelling has to settle the promise
  // itself or whoever awaits it waits for ever.
  let abort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });

  const decoded = api
    .decode(
      file,
      format,
      options.maxPoints ?? DEFAULT_MAX_POINTS,
      Comlink.proxy((loaded: number, total: number) => options.onProgress?.(loaded, total)),
    )
    .finally(() => {
      api[Comlink.releaseProxy]();
      worker.terminate();
    });

  return {
    done: Promise.race([decoded, aborted]),
    cancel: () => {
      worker.terminate();
      abort(new DOMException("Cancelled", "AbortError"));
    },
  };
}
