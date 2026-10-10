"use client";

/**
 * Main-thread handle on the CityJSON clipping worker.
 *
 * One worker, kept alive between loads — see `xmllint-client.ts` for the same
 * reasoning. Loading a second context file in the same session is common
 * enough (trying a different radius, a different file) that re-paying a
 * worker spin-up cost each time is not worth avoiding the reuse.
 */

import * as Comlink from "comlink";

import type {
  CityJsonWorkerApi,
} from "./cityjson.worker";
import type { CityJsonClipOptions, CityJsonParseResult } from "@/lib/georef/cityjson";

let worker: Worker | null = null;
let api: Comlink.Remote<CityJsonWorkerApi> | null = null;

function getApi(): Comlink.Remote<CityJsonWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./cityjson.worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<CityJsonWorkerApi>(worker);
  }
  return api;
}

export async function clipCityJson(
  text: string,
  options: CityJsonClipOptions,
): Promise<CityJsonParseResult> {
  return getApi().clip(text, options);
}

/** Release the worker. The app keeps it for the session otherwise. */
export function disposeCityJsonWorker() {
  worker?.terminate();
  worker = null;
  api = null;
}
