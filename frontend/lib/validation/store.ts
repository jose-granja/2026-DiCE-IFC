"use client";

/**
 * The IFC validation run (ADR 018): which model, how far it got, and what each
 * stage found. A store, not panel state, so switching tabs while a two-minute
 * run is going does not lose it.
 */

import { create } from "zustand";

import { unwrapModel } from "@/lib/viewer/container";
import { getSourceFile } from "@/lib/viewer/loader";
import { cancelValidation, runValidation, type ValidationEvent } from "@/lib/workers/ifc-validation-client";
import { VALIDATION_STAGES, type StageResult, type ValidationStage } from "./stages";

export type ValidationRun = {
  modelId: string;
  modelName: string;
  startedAt: number;
  finishedAt?: number;
  /** While running: Pyodide loading, or the stage under way. */
  loading?: Extract<ValidationEvent, { type: "loading" }>;
  current?: ValidationStage;
  results: Partial<Record<ValidationStage, StageResult>>;
  error?: string;
  cancelled?: boolean;
  /** WebAssembly memory the run held at its peak, in MB. */
  memoryMb?: number;
  /** It stopped because the browser's WebAssembly memory ran out. */
  outOfMemory?: boolean;
};

type ValidationState = {
  run: ValidationRun | null;
  start: (modelId: string, modelName: string) => Promise<void>;
  cancel: () => void;
  clear: () => void;
};

export const useIfcValidationStore = create<ValidationState>((set, get) => ({
  run: null,

  async start(modelId, modelName) {
    if (get().run && !get().run!.finishedAt) return;
    const file = getSourceFile(modelId);
    set({ run: { modelId, modelName, startedAt: Date.now(), results: {} } });
    const update = (patch: Partial<ValidationRun>) => {
      const run = get().run;
      if (run && run.modelId === modelId && !run.finishedAt) set({ run: { ...run, ...patch } });
    };
    try {
      if (!file) throw new Error("source file not available");
      // The service validates the .ifc itself: an ifcZIP is unwrapped first, as for viewing.
      const ifc = (await unwrapModel(file)).file;
      const bytes = new Uint8Array(await ifc.arrayBuffer());
      const output = await runValidation(bytes, [...VALIDATION_STAGES], (event) => {
        const run = get().run;
        if (!run || run.modelId !== modelId || run.finishedAt) return;
        if (event.type === "loading") update({ loading: event });
        else if (event.type === "stage-start") update({ loading: undefined, current: event.stage });
        else update({ results: { ...run.results, [event.result.stage]: event.result } });
      });
      update({ current: undefined, loading: undefined, finishedAt: Date.now(), memoryMb: output.memoryMb, outOfMemory: output.outOfMemory });
    } catch (error) {
      if (get().run?.cancelled) return;
      update({ current: undefined, loading: undefined, finishedAt: Date.now(), error: String((error as Error)?.message ?? error) });
    }
  },

  cancel() {
    const run = get().run;
    if (!run || run.finishedAt) return;
    cancelValidation();
    set({ run: { ...run, cancelled: true, current: undefined, loading: undefined, finishedAt: Date.now() } });
  },

  clear() {
    if (get().run && !get().run!.finishedAt) cancelValidation();
    set({ run: null });
  },
}));
