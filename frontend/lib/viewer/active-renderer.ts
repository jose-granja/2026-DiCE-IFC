"use client";

/**
 * The renderer instance currently mounted in the viewport.
 *
 * A module-level reference rather than context: the consumers are the workspace
 * actions, and later the BCF viewpoint restore and the IDS "show me this
 * failure" jump — none of which are children of the canvas, and all of which
 * want the camera. Threading a ref through the page for that would put viewer
 * plumbing in every module that touches the viewer.
 *
 * Null whenever no viewport is mounted; every caller must handle that.
 */

import type { ViewerRenderer } from "./renderer";

let active: ViewerRenderer | null = null;

export function setActiveRenderer(renderer: ViewerRenderer | null) {
  active = renderer;
}

export function getActiveRenderer(): ViewerRenderer | null {
  return active;
}
