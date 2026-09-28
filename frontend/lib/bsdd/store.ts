"use client";

/**
 * Which dictionaries the author has chosen.
 *
 * Persisted, because it is a project-level decision — a Portuguese practice
 * works against IFC plus whatever national dictionary applies, and re-picking
 * that on every visit would be a small daily tax.
 *
 * `localStorage` rather than OPFS: it is a list of public URIs, not user
 * content, and it has to be readable synchronously on first render so the
 * pickers do not flicker.
 */

import { create } from "zustand";

import type { BsddDictionary } from "./client";

const KEY = "dice-ifc.bsdd.dictionaries";

/** The IFC schema dictionary used by default for IDS authoring. */
export const IFC_4_3_DICTIONARY: BsddDictionary = {
  uri: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3",
  name: "IFC",
  code: "ifc",
  version: "4.3",
  organizationNameOwner: "buildingSMART",
};

type BsddState = {
  /** Chosen dictionaries, in the order they were added. */
  selected: BsddDictionary[];
  /** False until the persisted choice has been read. */
  hydrated: boolean;

  hydrate: () => void;
  add: (dictionary: BsddDictionary) => void;
  remove: (uri: string) => void;
  clear: () => void;
};

export const useBsddStore = create<BsddState>((set, get) => ({
  selected: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    try {
      const raw = window.localStorage.getItem(KEY);
      set({
        selected: raw
          ? (JSON.parse(raw) as BsddDictionary[])
          : [IFC_4_3_DICTIONARY],
        hydrated: true,
      });
    } catch {
      // A corrupt entry is not worth losing the useful IFC default over.
      set({ selected: [IFC_4_3_DICTIONARY], hydrated: true });
    }
  },

  add: (dictionary) =>
    set((state) => {
      if (state.selected.some((entry) => entry.uri === dictionary.uri)) return state;
      const selected = [...state.selected, dictionary];
      persist(selected);
      return { selected };
    }),

  remove: (uri) =>
    set((state) => {
      const selected = state.selected.filter((entry) => entry.uri !== uri);
      persist(selected);
      return { selected };
    }),

  clear: () => {
    persist([]);
    set({ selected: [] });
  },
}));

function persist(selected: BsddDictionary[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(selected));
  } catch {
    // Private browsing, or a full quota. The choice simply will not survive a
    // reload, which is not worth an error.
  }
}
