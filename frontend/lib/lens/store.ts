"use client";

/**
 * The lenses the user saved, which one is on, and what it currently shows.
 *
 * Saved lenses persist in `localStorage` (they are small, user-authored, and
 * belong to this browser like the clash matrix); a project folder carries them
 * too (`lib/project/`). `draft` is a lens being edited: while it exists it is
 * what the viewport shows, so every edit is previewed as it is made.
 */

import { create } from "zustand";

import type { LensLegendEntry } from "./evaluate";
import { builtinLens } from "./presets";
import { sanitiseLenses } from "./schema";
import type { Lens } from "./types";

const STORAGE_KEY = "dice-ifc.lenses.v1";

type Persisted = { lenses: Lens[]; activeId: string | null };

function load(): Persisted {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lenses: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return { lenses: sanitiseLenses(parsed.lenses), activeId: typeof parsed.activeId === "string" ? parsed.activeId : null };
  } catch {
    return { lenses: [], activeId: null };
  }
}

function persist(state: Persisted) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing can refuse; the lenses still work for this visit.
  }
}

export type LensStatus = "idle" | "running" | "ready" | "failed";

type LensState = Persisted & {
  /** Read from storage after mount, never during render (AGENTS.md §2a). */
  hydrated: boolean;
  draft: Lens | null;
  /** Legend entries switched off, for the lens on screen. */
  hiddenLegend: Set<string>;
  legend: LensLegendEntry[];
  status: LensStatus;
  error: string | null;

  hydrate: () => void;
  /** Turn a lens on, or every lens off with null. */
  activate: (id: string | null) => void;
  save: (lens: Lens) => void;
  remove: (id: string) => void;
  edit: (lens: Lens) => void;
  updateDraft: (lens: Lens) => void;
  /** Save the draft and keep it on. */
  commitDraft: () => void;
  cancelDraft: () => void;
  toggleLegend: (id: string) => void;
  setResult: (status: LensStatus, legend: LensLegendEntry[], error?: string | null) => void;
  /** A restored project's lenses replace these. */
  replace: (lenses: Lens[], activeId: string | null) => void;
  /**
   * A restored project's lenses join these — same id replaced, the rest kept —
   * and its active lens comes on. Opening someone's project must not take the
   * user's own lenses away.
   */
  merge: (lenses: Lens[], activeId: string | null) => void;
};

/** The lens a viewport should show: the one being edited, else the active one. */
export function shownLens(state: Pick<LensState, "draft" | "activeId" | "lenses">): Lens | null {
  if (state.draft) return state.draft;
  if (!state.activeId) return null;
  return builtinLens(state.activeId) ?? state.lenses.find((lens) => lens.id === state.activeId) ?? null;
}

export const useLensStore = create<LensState>((set, get) => {
  const keep = (patch: Partial<Persisted>) => {
    const next = { lenses: get().lenses, activeId: get().activeId, ...patch };
    set(next);
    persist(next);
  };
  return {
    lenses: [],
    activeId: null,
    hydrated: false,
    draft: null,
    hiddenLegend: new Set(),
    legend: [],
    status: "idle",
    error: null,

    hydrate: () => {
      if (get().hydrated) return;
      set({ ...load(), hydrated: true });
    },
    activate: (id) => {
      set({ hiddenLegend: new Set() });
      keep({ activeId: id });
    },
    save: (lens) => {
      const lenses = get().lenses;
      const at = lenses.findIndex((entry) => entry.id === lens.id);
      keep({ lenses: at >= 0 ? lenses.map((entry, i) => (i === at ? lens : entry)) : [...lenses, lens] });
    },
    remove: (id) => {
      const { activeId, draft } = get();
      if (draft?.id === id) set({ draft: null });
      keep({ lenses: get().lenses.filter((lens) => lens.id !== id), activeId: activeId === id ? null : activeId });
    },
    edit: (lens) => set({ draft: lens, hiddenLegend: new Set() }),
    updateDraft: (lens) => set({ draft: lens }),
    commitDraft: () => {
      const draft = get().draft;
      if (!draft) return;
      get().save(draft);
      set({ draft: null });
      keep({ activeId: draft.id });
    },
    cancelDraft: () => set({ draft: null, hiddenLegend: new Set() }),
    toggleLegend: (id) => {
      const next = new Set(get().hiddenLegend);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ hiddenLegend: next });
    },
    setResult: (status, legend, error = null) => set({ status, legend, error }),
    replace: (lenses, activeId) => {
      set({ draft: null, hiddenLegend: new Set() });
      keep({ lenses, activeId });
    },
    merge: (incoming, activeId) => {
      const ids = new Set(incoming.map((lens) => lens.id));
      set({ draft: null, hiddenLegend: new Set() });
      keep({ lenses: [...get().lenses.filter((lens) => !ids.has(lens.id)), ...incoming], activeId });
    },
  };
});

let sequence = 0;
/** A fresh id for a lens or rule the user creates. */
export function newLensId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}
