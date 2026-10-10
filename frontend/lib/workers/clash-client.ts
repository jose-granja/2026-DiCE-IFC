"use client";

import * as Comlink from "comlink";

import type { ClashWorkerApi } from "./clash.worker";
import type {
  ClashElementGeometry,
  ClashHit,
  ClashSettings,
  ClashTask,
} from "@/lib/clash/types";

/**
 * Run the engine in a worker of its own. One worker per run: the engine is a
 * single long synchronous loop, so the only way to cancel it is to end the
 * worker, and a fresh one is cheap next to a clash run.
 */
export async function detectInWorker(
  elements: ClashElementGeometry[],
  tasks: ClashTask[],
  settings: ClashSettings,
  options: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ hits: ClashHit[]; truncated: boolean }> {
  const worker = new Worker(new URL("./clash.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<ClashWorkerApi>(worker);

  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("Clash detection stopped.", "AbortError"));
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
  });

  try {
    // Handed over rather than copied: these arrays were read out of the
    // renderer for this run alone, and nothing here uses them afterwards.
    const buffers = elements.flatMap((element) => [
      element.positions.buffer as ArrayBuffer,
      element.indices.buffer as ArrayBuffer,
    ]);
    return await Promise.race([
      api.detect(
        Comlink.transfer(elements, buffers),
        tasks,
        settings,
        options.onProgress ? Comlink.proxy(options.onProgress) : undefined,
      ),
      aborted,
    ]);
  } finally {
    worker.terminate();
  }
}
