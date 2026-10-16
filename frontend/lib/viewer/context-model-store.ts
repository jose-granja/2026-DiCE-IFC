"use client";

/**
 * The context model (CityJSON, GeoJSON, CityGML, GeoPackage) shown around the
 * federation.
 *
 * Outside the Geo panel so it survives the panel unmounting — the geometry
 * already stayed in the scene when the user switched tabs, but the panel forgot
 * it had loaded anything and offered "Load context" over a city that was still
 * drawn — and so a project folder can save the file and put it back.
 *
 * Placing a context model needs the model's map conversion, which the Geo panel
 * works out. So a restored file is left in `pending` and the panel reads it the
 * next time it is mounted with a placement to put it in.
 */

import { create } from "zustand";

import type { ContextGeometry } from "@/lib/georef/context-geometry";

export const DEFAULT_CLIP_RADIUS_METRES = 100;

export type ContextModelSettings = {
  visible: boolean;
  clipEnabled: boolean;
  /** Kept as typed, so a half-edited radius is not rewritten under the cursor. */
  clipRadius: string;
};

type ContextModelState = ContextModelSettings & {
  /** The file the shown geometry came from, for saving into a project. */
  file: File | null;
  loaded: ContextGeometry | null;
  selectedFeature: number | null;
  selectFeature: (index: number | null) => void;
  clearSelection: () => void;
  /** A file from a restored project, waiting for the Geo panel to place it. */
  pending: File | null;
  /** Set when the panel has finished with `pending`, whether it placed it or not. */
  pendingOutcome: { ok: true } | { ok: false; error: string } | null;

  setLoaded: (file: File, loaded: ContextGeometry) => void;
  setSettings: (patch: Partial<ContextModelSettings>) => void;
  restore: (file: File, settings: ContextModelSettings) => void;
  finishPending: (outcome: { ok: true } | { ok: false; error: string }) => void;
  clear: () => void;
};

export const useContextModelStore = create<ContextModelState>((set) => ({
  visible: true,
  clipEnabled: true,
  clipRadius: String(DEFAULT_CLIP_RADIUS_METRES),
  file: null,
  loaded: null,
  selectedFeature: null,
  pending: null,
  pendingOutcome: null,

  selectFeature: (index) => set((state) => ({
    selectedFeature: state.visible && index !== null && state.loaded?.features?.[index] ? index : null,
  })),
  clearSelection: () => set({ selectedFeature: null }),
  setLoaded: (file, loaded) => set({ file, loaded, selectedFeature: null }),
  setSettings: (patch) => set({ ...patch, ...(patch.visible === false ? { selectedFeature: null } : {}) }),
  restore: (file, settings) => set({ ...settings, pending: file, pendingOutcome: null, selectedFeature: null }),
  finishPending: (outcome) => set({ pending: null, pendingOutcome: outcome }),
  clear: () => set({ file: null, loaded: null, pending: null, pendingOutcome: null, selectedFeature: null }),
}));
