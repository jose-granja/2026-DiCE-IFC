"use client";

/**
 * The quantity panel's saved list of queries, in `localStorage`.
 *
 * The panel owns the list while it is open and writes it here on every change.
 * A project restore writes it from outside, so it also announces the change:
 * a panel that is mounted at that moment reloads, and one that is not reads it
 * on its next mount, as it always has.
 */

import type { QuantityQuery } from "@/lib/ifc/types";

export const QUERY_LIST_STORAGE_KEY = "dice-ifc.quantity-query-list.v1";
/** Window event fired when something other than the panel replaces the list. */
export const QUERY_LIST_CHANGED_EVENT = "dice-ifc:quantity-query-list-changed";

export type StoredQueryListItem = {
  id: string;
  code?: string;
  description?: string;
  /** Legacy field from the first version of the quantity list. */
  name?: string;
  query: QuantityQuery;
};

export function readStoredQueryList(): StoredQueryListItem[] {
  try {
    const stored = window.localStorage.getItem(QUERY_LIST_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as StoredQueryListItem[]) : [];
  } catch {
    // Unavailable storage or a corrupt draft: an empty list, not a crash.
    return [];
  }
}

/** Replace the list from outside the panel, and tell a mounted panel to reload. */
export function replaceStoredQueryList(items: StoredQueryListItem[]) {
  try {
    window.localStorage.setItem(QUERY_LIST_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Private browsing can refuse the write; the event still carries the list.
  }
  window.dispatchEvent(new CustomEvent(QUERY_LIST_CHANGED_EVENT, { detail: items }));
}
