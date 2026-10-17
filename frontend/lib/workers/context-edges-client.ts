"use client";
import * as Comlink from "comlink";
import type { ContextGeometry } from "@/lib/georef/context-geometry";
import type { ContextEdgesWorkerApi } from "./context-edges.worker";

/** Never detach the geometry retained by the viewer/store. */
export async function prepareContextEdges(geometry: ContextGeometry): Promise<Uint8Array> {
  const worker = new Worker(new URL("./context-edges.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<ContextEdgesWorkerApi>(worker);
  try {
    const positions = geometry.positions.slice();
    return await api.build(Comlink.transfer(positions, [positions.buffer]), geometry.featureRanges ?? []);
  } finally {
    api[Comlink.releaseProxy]();
    worker.terminate();
  }
}
