"use client";

import * as Comlink from "comlink";

import type { Lab } from "@/lib/viewer/realistic/choose";
import { mapLimit, measureJob, type ColourJob } from "@/lib/viewer/realistic/source";
import type { TextureColourWorkerApi } from "./texture-colour.worker";

/** Jobs per round trip: progress moves at least this often. */
const CHUNK = 48;

/**
 * Measure preview colours in a worker, a chunk at a time so progress can be
 * shown and turning the feature off stops between chunks. Where workers are
 * missing, on this thread.
 */
export async function measureColoursInWorker(
  jobs: ColourJob[],
  concurrency: number,
  onDone: (count: number) => void,
  signal?: AbortSignal,
): Promise<Array<Lab | null>> {
  if (jobs.length === 0) return [];
  if (typeof Worker === "undefined") {
    return mapLimit(jobs, concurrency, async (job) => {
      const lab = await measureJob(job);
      onDone(1);
      return lab;
    });
  }
  const worker = new Worker(new URL("./texture-colour.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<TextureColourWorkerApi>(worker);
  try {
    const results: Array<Lab | null> = [];
    for (let at = 0; at < jobs.length; at += CHUNK) {
      if (signal?.aborted) break;
      const chunk = jobs.slice(at, at + CHUNK);
      results.push(...(await api.measure(chunk, concurrency)));
      onDone(chunk.length);
    }
    return results;
  } finally {
    api[Comlink.releaseProxy]();
    worker.terminate();
  }
}
