/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { GeoPackageError, parseGeoPackage, type GeoPackageOptions } from "@/lib/georef/geopackage";

const api = {
  async parse(bytes: Uint8Array, epsg: number | null, options: Omit<GeoPackageOptions, "onProgress">, onProgress?: (percent: number) => void) {
    try {
      const geometry = await parseGeoPackage(bytes, epsg, { ...options, onProgress });
      return Comlink.transfer({ ok: true as const, geometry }, [geometry.positions.buffer as ArrayBuffer, geometry.colours.buffer as ArrayBuffer]);
    } catch (error) {
      return { ok: false as const, error: error instanceof GeoPackageError ? error.code : "openFailed" as const };
    }
  },
};
export type GeoPackageWorkerApi = typeof api;
Comlink.expose(api);
