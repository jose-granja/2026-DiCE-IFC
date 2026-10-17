/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { contextEdgeMasks } from "@/lib/viewer/context-edges";
import type { ContextFeatureRange } from "@/lib/georef/context-geometry";

const api = {
  build(positions: Float32Array, ranges: ContextFeatureRange[]) {
    const masks = contextEdgeMasks(positions, ranges);
    return Comlink.transfer(masks, [masks.buffer]);
  },
};
export type ContextEdgesWorkerApi = typeof api;
Comlink.expose(api);
