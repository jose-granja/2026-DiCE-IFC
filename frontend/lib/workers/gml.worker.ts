/// <reference lib="webworker" />

import * as Comlink from "comlink";

import { parseLargeGml, type LargeGmlClipOptions } from "@/lib/georef/gml-stream";

const api = {
  async clip(
    file: Blob,
    options: Omit<LargeGmlClipOptions, "onProgress">,
    onProgress?: (percent: number) => void,
  ) {
    const result = await parseLargeGml(file, {
      ...options,
      onProgress: onProgress ? (percent) => onProgress(percent) : undefined,
    });
    return Comlink.transfer(result, [
      result.positions.buffer as ArrayBuffer,
      result.colours.buffer as ArrayBuffer,
    ]);
  },
};

export type GmlWorkerApi = typeof api;

Comlink.expose(api);
