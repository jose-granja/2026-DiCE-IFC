/// <reference lib="webworker" />
/**
 * Measures texture previews' colours for realistic materials (ADR 014), off
 * the main thread. Hundreds of small fetches and decodes are cheap here; on
 * the main thread each step waits for the viewer's next frame, which made a
 * first search take minutes on a heavy model.
 */
import * as Comlink from "comlink";

import { mapLimit, measureJob, type ColourJob } from "@/lib/viewer/realistic/source";

const api = {
  measure(jobs: ColourJob[], concurrency: number) {
    return mapLimit(jobs, concurrency, measureJob);
  },
};

export type TextureColourWorkerApi = typeof api;
Comlink.expose(api);
