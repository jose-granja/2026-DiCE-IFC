"use client";

/**
 * Realistic materials' switch and what it last did.
 *
 * Not part of the display settings a project saves: turning it on sends
 * requests to Poly Haven, and opening someone's project folder must not do
 * that on its own. Off on every visit for the same reason.
 */

import { create } from "zustand";

import type { AppliedTexture, RealisticProgress } from "./apply";
import type { TextureSourceId } from "./source";

/** Libraries by their own names, for credits and the list of what was applied. */
export const SOURCE_NAMES: Record<TextureSourceId, string> = { polyhaven: "Poly Haven", "360into": "360into" };

/** Their texture libraries' front pages, for the credit. */
export const SOURCE_HOMES: Record<TextureSourceId, string> = {
  polyhaven: "https://polyhaven.com/textures",
  "360into": "https://360into.com/",
};

export type RealisticStatus = "off" | "searching" | "ready" | "failed";

type RealisticState = {
  on: boolean;
  status: RealisticStatus;
  progress: RealisticProgress | null;
  applied: AppliedTexture[];
  texturedElements: number;
  skipped: number;
  unmatched: number;
  unreachable: TextureSourceId[];
  /** Vertices drawing a texture, for the tests (`data-surface-textured`). */
  textured: number;
  error: string | null;
  setOn: (on: boolean) => void;
  update: (patch: Partial<Omit<RealisticState, "setOn" | "update">>) => void;
};

export const useRealisticStore = create<RealisticState>((set) => ({
  on: false,
  status: "off",
  progress: null,
  applied: [],
  texturedElements: 0,
  skipped: 0,
  unmatched: 0,
  unreachable: [],
  textured: 0,
  error: null,
  setOn: (on) =>
    set(on
      ? { on, status: "searching", progress: null, error: null }
      : { on, status: "off", progress: null, applied: [], texturedElements: 0, skipped: 0, unmatched: 0, unreachable: [], textured: 0, error: null }),
  update: (patch) => set(patch),
}));
