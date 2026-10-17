"use client";

/**
 * Which side-panel tab the viewer shows.
 *
 * The page keeps the tab as its own state, followed from `?panel=`. This store
 * is how anything else reads it (a project folder saves it) and asks for a
 * different one (a restore opens the GIS tab to place a context model, then the
 * tab that was saved). A request is a fresh object each time, so asking for the
 * tab that is already showing — after the user clicked away from it — still
 * switches.
 */

import { create } from "zustand";

type PanelState = {
  /** What the page is showing, as it last reported. */
  current: string;
  request: { panel: string } | null;
  report: (panel: string) => void;
  open: (panel: string) => void;
};

export const useViewerPanelStore = create<PanelState>((set) => ({
  current: "structure",
  request: null,
  report: (panel) => set({ current: panel }),
  open: (panel) => set({ request: { panel } }),
}));
