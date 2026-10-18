"use client";
import * as Comlink from "comlink";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import type { Point2 } from "@/lib/georef/area-check";
import type { AreaCheckWorkerApi } from "./area-check.worker";

/** Keep expensive horizontal tests off the UI thread; never detach loaded data. */
export async function checkContextAreas(geometry: ContextGeometry, footprint: Point2[], signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./area-check.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<AreaCheckWorkerApi>(worker);
  let abort: () => void = () => {};
  try {
    const positions = geometry.positions.slice();
    const local: Point2[] = footprint.map(([x, y]) => [x - geometry.origin.easting, y - geometry.origin.northing]);
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([api.intersect(Comlink.transfer(positions, [positions.buffer]), geometry.featureRanges ?? [], local), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
    api[Comlink.releaseProxy]();
    worker.terminate();
  }
}
