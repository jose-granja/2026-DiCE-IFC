"use client";

/**
 * Main-thread handle on the IFC validation worker (ADR 018).
 *
 * One worker, kept between runs: loading Pyodide and its packages costs seconds
 * (and, the first time, a 60 MB download the browser then caches), and checking
 * a model again after fixing it is the normal case. Cancelling terminates it —
 * a Python run cannot be interrupted any other way — so the next run starts a
 * fresh one.
 */

import * as Comlink from "comlink";

import type { ValidationOutput, ValidationStage, ValidatorBuild } from "@/lib/validation/stages";
import type { IfcValidationWorkerApi, ValidationEvent } from "./ifc-validation.worker";

export type { ValidationEvent };

let worker: Worker | null = null;
let api: Comlink.Remote<IfcValidationWorkerApi> | null = null;

function getApi(): Comlink.Remote<IfcValidationWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./ifc-validation.worker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<IfcValidationWorkerApi>(worker);
  }
  return api;
}

/** What this deployment's validator was built from, or null when it has none. */
export async function validatorBuild(): Promise<ValidatorBuild | null> {
  try {
    const response = await fetch("/validator/build.json");
    return response.ok ? ((await response.json()) as ValidatorBuild) : null;
  } catch {
    return null;
  }
}

export async function runValidation(
  bytes: Uint8Array,
  stages: ValidationStage[],
  onEvent: (event: ValidationEvent) => void,
): Promise<ValidationOutput> {
  return getApi().run(Comlink.transfer(bytes, [bytes.buffer]), stages, Comlink.proxy(onEvent));
}

/** Stop a run now. The next run starts a new worker (and reloads Pyodide). */
export function cancelValidation() {
  worker?.terminate();
  worker = null;
  api = null;
}
