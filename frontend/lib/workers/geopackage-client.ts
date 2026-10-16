"use client";
import * as Comlink from "comlink";
import type { GeoPackageOptions } from "@/lib/georef/geopackage";
import type { GeoPackageWorkerApi } from "./geopackage.worker";

/** A load owns its SQLite heap; terminating it also releases the database's peak memory. */
export async function readGeoPackage(bytes: Uint8Array, epsg: number | null, options: Omit<GeoPackageOptions, "onProgress">, onProgress?: (percent: number) => void) {
  const worker = new Worker(new URL("./geopackage.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<GeoPackageWorkerApi>(worker);
  try {
    return await api.parse(Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]), epsg, options, onProgress ? Comlink.proxy(onProgress) : undefined);
  } finally {
    api[Comlink.releaseProxy]();
    worker.terminate();
  }
}
