"use client";

/**
 * Realistic materials' switch and what it last did.
 *
 * Off on every visit: the viewer opens with the model's own colours, and
 * textures only when asked for, or when a project saved with them on is
 * opened (`viewer.realisticMaterials`).
 */

import { create } from "zustand";

import type { AppliedTexture, RealisticProgress } from "./apply";

export { SOURCE_HOMES, SOURCE_NAMES } from "./library";

/** `unavailable`: this server has no texture library (none installed, or the service is down). */
export type RealisticStatus = "off" | "searching" | "ready" | "failed" | "unavailable";

/** Where an earlier version remembered the switch; cleared, no longer read. */
export const LEGACY_REALISTIC_KEY = "dice-realistic-on";

type RealisticState = {
  on: boolean;
  status: RealisticStatus;
  progress: RealisticProgress | null;
  applied: AppliedTexture[];
  texturedElements: number;
  skipped: number;
  unmatched: number;
  /** The size the layers were drawn at. */
  size: number;
  /** Vertices drawing a texture, for the tests (`data-surface-textured`). */
  textured: number;
  error: string | null;
  setOn: (on: boolean) => void;
  update: (patch: Partial<Omit<RealisticState, "setOn" | "update">>) => void;
};

/** Drop what an earlier version left in this browser. */
export function forgetLegacySwitch() {
  try {
    localStorage.removeItem(LEGACY_REALISTIC_KEY);
  } catch {
    // Storage blocked: nothing was stored either.
  }
}

export const useRealisticStore = create<RealisticState>((set) => ({
  on: false,
  status: "off",
  progress: null,
  applied: [],
  texturedElements: 0,
  skipped: 0,
  unmatched: 0,
  size: 1024,
  textured: 0,
  error: null,
  setOn: (on) => {
    set(on
      ? { on, status: "searching", progress: null, error: null }
      : { on, status: "off", progress: null, applied: [], texturedElements: 0, skipped: 0, unmatched: 0, textured: 0, error: null });
  },
  update: (patch) => set(patch),
}));
