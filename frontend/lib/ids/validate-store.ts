"use client";

/**
 * State for the IDS validation module.
 *
 * The run itself is the interesting part: validation happens **once per model**
 * in the worker pool, and the per-model reports are aggregated into one
 * federation-wide `ValidationRun` (see `report.ts`).
 *
 * Models are validated **sequentially, not in parallel**. Each run is pure CPU
 * over every entity in a model, and starting four at once on a four-core laptop
 * makes all four finish at roughly the same late moment while the progress bar
 * sits still. One at a time gives honest progress and leaves cores for the
 * renderer.
 */

import { create } from "zustand";

import { getModelHandle } from "@/lib/viewer/loader";
import { useViewerStore } from "@/lib/viewer/store";
import type { IdsModelReport } from "@/lib/ifc/types";
import { aggregate, type ValidationRun } from "./report";

export type RunStatus = "idle" | "running" | "done" | "failed";

export type RunProgress = {
  /** Model currently being validated. */
  modelName: string;
  modelIndex: number;
  totalModels: number;
  /** 0–100 within the current model. */
  percent: number;
  specificationIndex: number;
  totalSpecifications: number;
};

type ValidateState = {
  /** The IDS being validated, as XML — the form the engine's parser takes. */
  idsXml: string | null;
  idsTitle: string;
  /** Where the IDS came from, for the UI to report. */
  source: "file" | "editor" | null;

  status: RunStatus;
  progress: RunProgress | null;
  error: string | null;
  run: ValidationRun | null;

  /** Which specification the failure table is showing. Null means all. */
  focusedSpecification: number | null;
  /** Which failure is selected, by `Failure.id`. */
  focusedFailure: string | null;

  setIds: (xml: string, title: string, source: "file" | "editor") => void;
  validate: () => Promise<void>;
  cancel: () => void;
  focusSpecification: (index: number | null) => void;
  focusFailure: (id: string | null) => void;
  reset: () => void;
};

/**
 * Cancellation flag.
 *
 * Outside the store because the running loop reads it between models and must
 * see the current value, not the one captured when the run started.
 */
let cancelled = false;

export const useValidateStore = create<ValidateState>((set, get) => ({
  idsXml: null,
  idsTitle: "",
  source: null,
  status: "idle",
  progress: null,
  error: null,
  run: null,
  focusedSpecification: null,
  focusedFailure: null,

  setIds: (idsXml, idsTitle, source) =>
    set({
      idsXml,
      idsTitle,
      source,
      // A previous run describes a different specification; keeping it on
      // screen next to a newly loaded IDS would be actively misleading.
      run: null,
      status: "idle",
      error: null,
      progress: null,
      focusedSpecification: null,
      focusedFailure: null,
    }),

  validate: async () => {
    const { idsXml, idsTitle } = get();
    if (!idsXml) return;

    const models = useViewerStore
      .getState()
      .models.filter((model) => model.load.status === "ready");

    if (models.length === 0) {
      set({ status: "failed", error: "Load at least one model in the viewer first." });
      return;
    }

    cancelled = false;
    const startedAt = new Date().toISOString();
    set({ status: "running", error: null, run: null, progress: null });

    try {
      const reports: IdsModelReport[] = [];

      for (const [index, model] of models.entries()) {
        if (cancelled) break;

        const handle = getModelHandle(model.summary.id);
        if (!handle) continue;

        set({
          progress: {
            modelName: model.summary.name,
            modelIndex: index,
            totalModels: models.length,
            percent: 0,
            specificationIndex: 0,
            totalSpecifications: 0,
          },
        });

        reports.push(
          await handle.validateIds(idsXml, {
            onProgress: (progress) =>
              set((state) =>
                state.progress
                  ? {
                      progress: {
                        ...state.progress,
                        percent: progress.percent,
                        specificationIndex: progress.specificationIndex,
                        totalSpecifications: progress.totalSpecifications,
                      },
                    }
                  : state,
              ),
          }),
        );
      }

      if (cancelled) {
        set({ status: "idle", progress: null });
        return;
      }

      set({
        status: "done",
        progress: null,
        run: aggregate(
          reports,
          models.map((model) => ({
            modelId: model.summary.id,
            name: model.summary.name,
          })),
          {
            idsTitle: idsTitle || "IDS validation",
            startedAt,
            finishedAt: new Date().toISOString(),
          },
        ),
      });
    } catch (error) {
      set({
        status: "failed",
        progress: null,
        error:
          error instanceof Error ? error.message : "Validation failed unexpectedly.",
      });
    }
  },

  cancel: () => {
    cancelled = true;
  },

  focusSpecification: (index) =>
    set({ focusedSpecification: index, focusedFailure: null }),
  focusFailure: (id) => set({ focusedFailure: id }),

  reset: () =>
    set({
      idsXml: null,
      idsTitle: "",
      source: null,
      status: "idle",
      progress: null,
      error: null,
      run: null,
      focusedSpecification: null,
      focusedFailure: null,
    }),
}));
