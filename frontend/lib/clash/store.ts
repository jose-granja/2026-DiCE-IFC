"use client";

import { create } from "zustand";

import {
  emptyMatrix,
  newGroup,
  newTolerance,
  removeGroup as dropGroup,
  removeTolerance as dropTolerance,
  sanitiseMatrix,
  setRule as setMatrixRule,
} from "./matrix";
import { clearClashHighlight } from "./highlight";
import { runClashMatrix, ClashRunError } from "./run";
import type {
  ClashGroup,
  ClashMatrix,
  ClashProgress,
  ClashRunResult,
  ClashSettings,
  ClashTolerance,
} from "./types";

const STORAGE_KEY = "dice-ifc.clash-matrix.v1";

function readStored(): ClashMatrix {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitiseMatrix(JSON.parse(raw)) : emptyMatrix();
  } catch {
    return emptyMatrix();
  }
}

function persist(matrix: ClashMatrix) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(matrix));
  } catch {
    // Private mode or a full quota: the matrix still works for this session.
  }
}

type ClashState = {
  matrix: ClashMatrix;
  result: ClashRunResult | null;
  running: boolean;
  progress: ClashProgress | null;
  error: string | null;
  /** Clashes the user has set aside; left out of exports. */
  ignored: Set<string>;

  setMatrix: (matrix: ClashMatrix) => void;
  addGroup: () => string;
  updateGroup: (id: string, patch: Partial<ClashGroup>) => void;
  removeGroup: (id: string) => void;
  duplicateGroup: (id: string) => void;
  addTolerance: () => void;
  updateTolerance: (id: string, patch: Partial<ClashTolerance>) => void;
  removeTolerance: (id: string) => void;
  setRule: (a: string, b: string, toleranceId: string | null) => void;
  updateSettings: (patch: Partial<ClashSettings>) => void;
  /** Classify an open model by discipline; an empty one unclassifies it. */
  setModelDiscipline: (modelName: string, discipline: string) => void;

  run: () => Promise<void>;
  cancel: () => void;
  clearResult: () => void;
  toggleIgnored: (id: string) => void;
  /** Reset the in-memory state; the saved matrix is kept. */
  reset: () => void;
};

let controller: AbortController | null = null;

export const useClashStore = create<ClashState>((set, get) => {
  /** Apply a change to the matrix and save it. */
  const edit = (change: (matrix: ClashMatrix) => ClashMatrix) =>
    set((state) => {
      const matrix = change(state.matrix);
      persist(matrix);
      return { matrix };
    });

  return {
    matrix: readStored(),
    result: null,
    running: false,
    progress: null,
    error: null,
    ignored: new Set(),

    setMatrix: (matrix) => edit(() => matrix),

    addGroup: () => {
      const group = newGroup(`Group ${get().matrix.groups.length + 1}`);
      edit((matrix) => ({ ...matrix, groups: [...matrix.groups, group] }));
      return group.id;
    },

    updateGroup: (id, patch) =>
      edit((matrix) => ({
        ...matrix,
        groups: matrix.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)),
      })),

    removeGroup: (id) => edit((matrix) => dropGroup(matrix, id)),

    duplicateGroup: (id) =>
      edit((matrix) => {
        const source = matrix.groups.find((group) => group.id === id);
        if (!source) return matrix;
        const copy = { ...newGroup(`${source.name} copy`), filter: structuredClone(source.filter), discipline: source.discipline };
        return { ...matrix, groups: [...matrix.groups, copy] };
      }),

    addTolerance: () =>
      edit((matrix) => ({
        ...matrix,
        tolerances: [...matrix.tolerances, newTolerance({ name: `Tolerance ${matrix.tolerances.length + 1}` })],
      })),

    updateTolerance: (id, patch) =>
      edit((matrix) => ({
        ...matrix,
        tolerances: matrix.tolerances.map((tolerance) =>
          tolerance.id === id ? { ...tolerance, ...patch } : tolerance,
        ),
      })),

    removeTolerance: (id) => edit((matrix) => dropTolerance(matrix, id)),

    setRule: (a, b, toleranceId) => edit((matrix) => setMatrixRule(matrix, a, b, toleranceId)),

    setModelDiscipline: (modelName, discipline) =>
      edit((matrix) => {
        const next = { ...(matrix.modelDisciplines ?? {}) };
        if (discipline.trim()) next[modelName] = discipline;
        else delete next[modelName];
        return { ...matrix, modelDisciplines: next };
      }),

    updateSettings: (patch) =>
      edit((matrix) => ({ ...matrix, settings: { ...matrix.settings, ...patch } })),

    run: async () => {
      if (get().running) return;
      controller = new AbortController();
      // Last run's clash is no longer what is being looked at.
      clearClashHighlight();
      set({ running: true, error: null, progress: null });
      try {
        const result = await runClashMatrix(get().matrix, {
          signal: controller.signal,
          onProgress: (progress) => set({ progress }),
        });
        set({ result, ignored: new Set() });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          set({ error: null });
        } else {
          set({
            error:
              error instanceof ClashRunError || error instanceof Error
                ? error.message
                : "Clash detection failed.",
          });
        }
      } finally {
        controller = null;
        set({ running: false, progress: null });
      }
    },

    cancel: () => controller?.abort(),

    clearResult: () => {
      clearClashHighlight();
      set({ result: null, ignored: new Set(), error: null });
    },

    toggleIgnored: (id) =>
      set((state) => {
        const ignored = new Set(state.ignored);
        if (!ignored.delete(id)) ignored.add(id);
        return { ignored };
      }),

    reset: () => {
      clearClashHighlight();
      set({ result: null, running: false, progress: null, error: null, ignored: new Set() });
    },
  };
});
