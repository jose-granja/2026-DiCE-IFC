/**
 * Clash detection: shared types.
 *
 * The model is a Solibri-style matrix. Element *groups* are chosen by filters
 * (IFC class, name, predefined type, object type, material, material category,
 * property in a property set); each *cell* of the matrix between two groups
 * names a *tolerance*; running the matrix produces *clashes*, each between one
 * element of each group.
 */

import type { ElementFilter } from "@/lib/ifc/types";

export type Vec3 = [number, number, number];

/** A named set of elements, chosen by filters. */
export type ClashGroup = {
  id: string;
  name: string;
  /** Optional discipline label, like the first row of a Solibri matrix. */
  discipline?: string;
  /**
   * What the project still has to say for this group to select the right
   * elements — shown on the group, not used by the engine. A template sets it
   * where the IFC class alone cannot tell two groups apart.
   */
  note?: string;
  filter: ElementFilter;
};

/**
 * How close two elements may be before it counts as a clash.
 *
 * - `hard`: the elements intersect. An overlap is ignored when it is not deeper
 *   than the tolerance: `horizontal` metres if it is thinnest sideways,
 *   `vertical` if it is thinnest in height. Depth is how far one element would
 *   have to move to clear the other, not how widely they touch — a wall
 *   resting on a slab touches along its whole length and overlaps by nothing,
 *   and a thin sliver at a wall joint is long but not deep. With `useVolume`
 *   an overlap is also ignored when the volume the two share is below
 *   `volume` cubic metres.
 * - `clearance`: report the pair when the gap between them is below
 *   `clearance` metres (and, trivially, when they intersect).
 */
export type ClashTolerance = {
  id: string;
  name: string;
  mode: "hard" | "clearance";
  horizontal: number;
  vertical: number;
  clearance: number;
  /** Also ignore an overlap whose volume is below `volume` cubic metres. */
  useVolume: boolean;
  volume: number;
};

/** One cell of the matrix. Unordered: A×B and B×A are the same rule. */
export type ClashRule = {
  a: string;
  b: string;
  toleranceId: string;
};

export type ClashSettings = {
  /** Report elements whose surfaces cross (a hard clash). */
  checkOverlap: boolean;
  /** Report an element sitting entirely inside another with no surface crossing. */
  checkInside: boolean;
  /** Report two elements with identical geometry in the same place. */
  checkDuplicate: boolean;
  /** Do not test elements that belong to the same model. */
  ignoreSameModel: boolean;
  /** Stop after this many clashes, so a bad matrix cannot flood the page. */
  maxClashes: number;
};

export const DEFAULT_CLASH_SETTINGS: ClashSettings = {
  checkOverlap: true,
  checkInside: true,
  checkDuplicate: true,
  ignoreSameModel: false,
  maxClashes: 5000,
};

export type ClashMatrix = {
  groups: ClashGroup[];
  tolerances: ClashTolerance[];
  rules: ClashRule[];
  settings: ClashSettings;
};

export type ClashKind = "hard" | "clearance" | "inside" | "duplicate";

/** What the engine is given for one element: triangles in the shared world frame. */
export type ClashElementGeometry = {
  key: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Elements of the same model are skipped when `ignoreSameModel` is on. */
  modelId: string;
};

/** One rule to run: the elements of two groups and the tolerance between them. */
export type ClashTask = {
  id: string;
  a: string[];
  b: string[];
  mode: ClashTolerance["mode"];
  horizontal: number;
  vertical: number;
  clearance: number;
  useVolume: boolean;
  volume: number;
};

export type ClashHit = {
  taskId: string;
  a: string;
  b: string;
  kind: ClashKind;
  /** Gap between the elements, metres; 0 when they intersect. */
  distance: number;
  /** How deep a hard clash goes, metres (0 for the other kinds). */
  depth: number;
  /** Volume the two elements share, cubic metres, when it could be measured. */
  volume?: number;
  /** Size of the region where they cross along world x, y (up) and z, metres. */
  extent: Vec3;
  /** Where to look: the middle of the clash region. */
  point: Vec3;
  min: Vec3;
  max: Vec3;
};

/** An element involved in a clash, with what a reader needs to find it. */
export type ClashElementRef = {
  /** `modelId#expressId`, the viewer store's own key. */
  key: string;
  modelId: string;
  modelName: string;
  expressId: number;
  type: string;
  name: string;
  globalId: string;
};

export type ClashResultItem = ClashHit & {
  id: string;
  elementA: ClashElementRef;
  elementB: ClashElementRef;
  /** "Group A × Group B". */
  rule: string;
  toleranceName: string;
};

export type ClashRunResult = {
  items: ClashResultItem[];
  /** The run stopped at `ClashSettings.maxClashes`. */
  truncated: boolean;
  /** How many elements each group selected (with geometry), by group id. */
  groupCounts: Record<string, number>;
  /** Selected elements that had no geometry to test. */
  withoutGeometry: number;
  durationMs: number;
  finishedAt: string;
};

export type ClashProgress = {
  phase: "selecting" | "geometry" | "detecting";
  done: number;
  total: number;
};
