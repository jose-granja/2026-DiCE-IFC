/**
 * buildingSMART's validation service in a Web Worker (ADR 018).
 *
 * Pyodide and everything it runs come from `/validator/` on this origin, built
 * by `scripts/build-validator-assets.mts`: nothing is fetched from anywhere else
 * (`connect-src 'self'`), and the model is written to Pyodide's in-memory file
 * system — it never leaves the device.
 *
 * Pyodide's loader is imported at run time from `/validator/pyodide.mjs`, not
 * bundled (`turbopackIgnore`): it locates its WebAssembly and standard library
 * next to itself.
 */

import * as Comlink from "comlink";

import { blockedBy, isOutOfMemory, type StageResult, type ValidationOutput, type ValidationStage } from "@/lib/validation/stages";

const BASE = "/validator/";

type Pyodide = {
  loadPackage: (names: string[], options?: { messageCallback?: (message: string) => void }) => Promise<unknown>;
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  unpackArchive: (buffer: ArrayBuffer, format: string, options?: { extractDir?: string }) => void;
  FS: { writeFile: (path: string, data: Uint8Array) => void; unlink: (path: string) => void; mkdirTree: (path: string) => void };
  /** Pyodide's Emscripten module (internal): its heap is what memory the run holds. */
  _module?: { HEAP8?: Int8Array };
};

const memoryMb = (py: Pyodide | null) => Math.round((py?._module?.HEAP8?.length ?? 0) / 1e6);

export type ValidationEvent =
  | { type: "loading"; step: "runtime" | "packages" | "rules"; done: number; total: number }
  | { type: "stage-start"; stage: ValidationStage }
  | { type: "stage"; result: StageResult };

let runtime: Promise<Pyodide> | null = null;

async function fetchBytes(name: string): Promise<ArrayBuffer> {
  const response = await fetch(`${BASE}${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function load(onEvent: (event: ValidationEvent) => void): Promise<Pyodide> {
  const origin = self.location.origin;
  onEvent({ type: "loading", step: "runtime", done: 0, total: 1 });
  const { loadPyodide } = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ `${origin}${BASE}pyodide.mjs`);
  const py: Pyodide = await loadPyodide({
    indexURL: `${origin}${BASE}`,
    lockFileURL: `${origin}${BASE}pyodide-lock.json`,
    // A fixed hash seed: Python orders sets of strings by hash, and the rules
    // print sets in messages and pick a version among a rule's tags from one.
    // Fixed, the same model gives the same result on every run.
    env: { PYTHONHASHSEED: "0" },
    stdout: () => {},
    stderr: () => {},
  });
  const lock = await (await fetch(`${BASE}pyodide-lock.json`)).json() as { packages: Record<string, unknown> };
  const names = Object.keys(lock.packages);
  let done = 0;
  onEvent({ type: "loading", step: "packages", done, total: names.length });
  await py.loadPackage(names, {
    messageCallback: (message) => {
      if (/^Loaded /.test(message)) onEvent({ type: "loading", step: "packages", done: ++done, total: names.length });
    },
  });
  onEvent({ type: "loading", step: "rules", done: 0, total: 1 });
  const site = py.runPython("import site; site.getsitepackages()[0]") as string;
  py.unpackArchive(await fetchBytes("site-overlay.zip"), "zip", { extractDir: site });
  py.unpackArchive(await fetchBytes("validator.zip"), "zip", { extractDir: "/validator" });
  py.runPython("import sys; sys.path.insert(0, '/validator'); import dice_validator");
  onEvent({ type: "loading", step: "rules", done: 1, total: 1 });
  return py;
}

const api = {
  /**
   * Run `stages` on one IFC file, in the service's order, skipping what an
   * earlier failure blocks (as the service does). Results arrive one by one
   * through `onEvent`, and all together at the end.
   */
  async run(
    bytes: Uint8Array,
    stages: ValidationStage[],
    onEvent: (event: ValidationEvent) => void,
  ): Promise<ValidationOutput> {
    runtime ??= load(onEvent).catch((error) => {
      runtime = null;
      throw error;
    });
    const py = await runtime;
    const path = "/work/model.ifc";
    const results: Partial<Record<ValidationStage, StageResult>> = {};
    let outOfMemory = false;
    try {
      py.FS.mkdirTree("/work");
      py.FS.writeFile(path, bytes);
      for (const stage of stages) {
        const blocker = blockedBy(results).get(stage);
        let result: StageResult;
        if (outOfMemory) {
          // After running out of memory the interpreter is gone: nothing more can run.
          result = { stage, status: "skipped", outcomes: [], info: { reason: "memory" } };
        } else if (blocker) {
          result = { stage, status: "skipped", outcomes: [], info: { reason: blocker } };
        } else {
          onEvent({ type: "stage-start", stage });
          try {
            result = JSON.parse((await py.runPythonAsync(`dice_validator.run_stage(${JSON.stringify(stage)}, ${JSON.stringify(path)})`)) as string);
          } catch (error) {
            const message = String((error as Error)?.message ?? error);
            outOfMemory = isOutOfMemory(message);
            result = {
              stage, status: "failed", outcomes: [],
              info: outOfMemory ? { reason: "memory", outOfMemory: true } : { reason: message.split("\n").slice(-3).join("\n") },
            };
          }
        }
        results[stage] = result;
        onEvent({ type: "stage", result });
      }
    } catch (error) {
      // Writing the file itself can be what runs out.
      if (!isOutOfMemory(String((error as Error)?.message ?? error))) throw error;
      outOfMemory = true;
    } finally {
      if (outOfMemory) {
        runtime = null;
      } else {
        try {
          py.FS.unlink(path);
        } catch {
          // Already gone.
        }
      }
    }
    return { results: stages.map((stage) => results[stage]!).filter(Boolean), memoryMb: memoryMb(py), outOfMemory };
  },
};

export type IfcValidationWorkerApi = typeof api;

Comlink.expose(api);
