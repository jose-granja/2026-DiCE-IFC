/// <reference lib="webworker" />

/**
 * The clash worker: pure geometry in, clashes out. It never sees an IFC file
 * and has no network call.
 */

import * as Comlink from "comlink";

import { detectClashes } from "@/lib/clash/engine";
import type {
  ClashElementGeometry,
  ClashHit,
  ClashSettings,
  ClashTask,
} from "@/lib/clash/types";

const api = {
  detect(
    elements: ClashElementGeometry[],
    tasks: ClashTask[],
    settings: ClashSettings,
    onProgress?: (done: number, total: number) => void,
  ): { hits: ClashHit[]; truncated: boolean } {
    return detectClashes(elements, tasks, settings, {
      onProgress: onProgress ? (done, total) => onProgress(done, total) : undefined,
    });
  },
};

export type ClashWorkerApi = typeof api;

Comlink.expose(api);
