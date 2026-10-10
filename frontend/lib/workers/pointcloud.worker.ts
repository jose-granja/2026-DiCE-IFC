/**
 * Point-cloud decoding, off the UI thread.
 *
 * A scan is hundreds of megabytes and millions of records; decoding it on the
 * main thread freezes the tab (AGENTS.md §7). The decoder itself is
 * `lib/pointcloud/decode.ts`, which is plain functions over a `Blob` and is
 * tested in Node; this only adds the worker boundary.
 *
 * `File` objects are cloned by reference, so the file's bytes are read here and
 * never copied through the message. The result's buffers are *transferred* back,
 * not copied — see `lib/workers/ifc.worker.ts` for why buffers that belong to
 * somebody else must not be, which is not the case for arrays this function
 * allocated itself.
 */
import * as Comlink from "comlink";

import { decodePointCloud, type DecodedPointCloud } from "@/lib/pointcloud/decode";
import type { PointCloudFormat } from "@/lib/pointcloud/formats";

export const pointCloudApi = {
  async decode(
    file: Blob,
    format: PointCloudFormat,
    maxPoints: number,
    onProgress: (done: number, total: number) => void,
  ): Promise<DecodedPointCloud> {
    const cloud = await decodePointCloud(file, format, { maxPoints, onProgress });
    const buffers = [cloud.positions.buffer, cloud.colours?.buffer, cloud.intensities?.buffer].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
    );
    return Comlink.transfer(cloud, buffers);
  },
};

export type PointCloudWorkerApi = typeof pointCloudApi;

Comlink.expose(pointCloudApi);
