"use client";

/**
 * Showing a clash in the viewer — colouring its two elements, optionally
 * isolating them, framing the spot — and taking it all back again.
 *
 * The colours belong to that one view of the model. The moment anything else
 * changes what is on screen (Show all, a class filter, hiding or isolating
 * something, another clash) they are removed, so a red wall does not survive
 * into a view that has nothing to do with the clash.
 */

import { getActiveRenderer } from "@/lib/viewer/active-renderer";
import { useViewerStore } from "@/lib/viewer/store";
import { CLASH_COLOUR_A, CLASH_COLOUR_B } from "./colours";
import { clashView } from "./frame";
import type { ClashResultItem } from "./types";

type Active = {
  keys: string[];
  /** The view this highlight was drawn in; any other means the view changed. */
  isolated: unknown;
  hidden: unknown;
  facetVisible: unknown;
  typeVisibility: unknown;
};

let active: Active | null = null;
let unsubscribe: (() => void) | null = null;
/** Our own writes to the store are not "the view changing". */
let applying = false;
let suspended = 0;

const snapshotOf = (keys: string[]): Active => {
  const state = useViewerStore.getState();
  return {
    keys,
    isolated: state.isolated,
    hidden: state.hidden,
    facetVisible: state.facetVisible,
    typeVisibility: state.typeVisibility,
  };
};

/** Remove the clash colours (and stop watching), leaving the rest of the view as it is. */
export function clearClashHighlight() {
  unsubscribe?.();
  unsubscribe = null;
  if (!active) return;
  const keys = active.keys;
  active = null;

  useViewerStore.setState((state) => {
    if (!keys.some((key) => state.colouring.has(key))) return {};
    const colouring = new Map(state.colouring);
    for (const key of keys) colouring.delete(key);
    return { colouring };
  });
}

function watch() {
  unsubscribe?.();
  unsubscribe = useViewerStore.subscribe((state) => {
    if (!active || applying || suspended > 0) return;
    if (
      state.isolated !== active.isolated ||
      state.hidden !== active.hidden ||
      state.facetVisible !== active.facetVisible ||
      state.typeVisibility !== active.typeVisibility
    ) {
      clearClashHighlight();
    }
  });
}

/**
 * Run something that moves the viewer around on the clash's behalf (the BCF
 * export isolates and colours each clash in turn) without that counting as the
 * view changing; the highlight is as it was afterwards.
 */
export async function withClashHighlightPaused<T>(work: () => Promise<T>): Promise<T> {
  suspended += 1;
  try {
    return await work();
  } finally {
    suspended -= 1;
    if (active && suspended === 0) active = snapshotOf(active.keys);
  }
}

export function showClash(item: ClashResultItem, isolateBoth: boolean) {
  const renderer = getActiveRenderer();
  const store = useViewerStore.getState();
  const refs = [item.elementA, item.elementB]
    .filter((element) => store.models.some((model) => model.summary.id === element.modelId))
    .map(({ modelId, expressId }) => ({ modelId, expressId }));
  if (refs.length === 0) return;

  // The previous clash's colours go first, whatever else is about to change.
  clearClashHighlight();

  applying = true;
  try {
    if (isolateBoth) store.isolate(refs);
    else if (store.isolated) store.clearIsolation();
    // Not selected: a selected element is painted the selection blue, which
    // would hide the red/blue that tells the two apart.
    store.clearSelection();

    const keys = [item.elementA.key, item.elementB.key];
    useViewerStore.setState((state) => {
      const colouring = new Map(state.colouring);
      colouring.set(item.elementA.key, CLASH_COLOUR_A);
      colouring.set(item.elementB.key, CLASH_COLOUR_B);
      return { colouring };
    });
    active = snapshotOf(keys);
  } finally {
    applying = false;
  }
  watch();

  const view = clashView(item);
  renderer?.fitToBounds(view.bounds, view.direction);
}
