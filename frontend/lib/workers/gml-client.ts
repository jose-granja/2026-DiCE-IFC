"use client";

import * as Comlink from "comlink";

import type { LargeGmlClipOptions } from "@/lib/georef/gml-stream";
import type { GmlWorkerApi } from "./gml.worker";

let worker: Worker | null = null;
let api: Comlink.Remote<GmlWorkerApi> | null = null;

function getApi() {
  if (!api) {
    worker = new Worker(new URL("./gml.worker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<GmlWorkerApi>(worker);
  }
  return api;
}

export function clipLargeGml(
  file: Blob,
  options: Omit<LargeGmlClipOptions, "onProgress">,
  onProgress?: (percent: number) => void,
) {
  return getApi().clip(
    file,
    options,
    onProgress ? Comlink.proxy(onProgress) : undefined,
  );
}

export function disposeGmlWorker() {
  worker?.terminate();
  worker = null;
  api = null;
}
