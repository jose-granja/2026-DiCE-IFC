"use client";

/**
 * Where the globe's canvas is, for the panel that switches it on.
 *
 * The canvas belongs to `ViewerCanvas` — it has to sit behind the model canvas
 * in the same stacking context — but the control that creates a globe lives in
 * the georeferencing panel, several components away. A module-scoped handle is
 * the same shape as `active-renderer.ts`, and for the same reason: there is
 * exactly one viewport, and threading a ref through the tree would be
 * ceremony around a singleton.
 */

let canvas: HTMLElement | null = null;

export function setGlobeCanvas(element: HTMLElement | null) {
  canvas = element;
}

export function getGlobeCanvas(): HTMLElement | null {
  return canvas;
}
