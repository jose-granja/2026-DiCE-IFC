/**
 * Turning a lens and the elements it selected into what the viewport draws.
 *
 * Pure: the worker answers "which elements does this rule pick" and "which
 * value does each element have" (`use-lens.ts`); this decides colours, hiding
 * and ghosting, and the legend. Engine-free, so it is tested on its own.
 */

import { GHOST_COLOUR, paletteColour } from "./palette";
import type { Lens, LensAction, RefKey } from "./types";

export type LensInput =
  | {
      kind: "rules";
      /** Every element the lens could apply to. */
      universe: RefKey[];
      /** What each enabled rule selected, in the lens's order. */
      matches: Array<{ ruleId: string; refs: RefKey[] }>;
    }
  | {
      kind: "auto";
      universe: RefKey[];
      /** Each value with its elements, already merged across models. */
      groups: Array<{ value: string; refs: RefKey[] }>;
    };

export type LensView = {
  colours: Map<RefKey, string>;
  hidden: Set<RefKey>;
  /** Drawn see-through: `transparent` rules, and the ghosted unmatched. */
  translucent: Set<RefKey>;
};

export type LensLegendEntry = {
  /** A rule id, `value:<value>` for an auto group, or `unmatched`. */
  id: string;
  /** A rule's name or a group's value; empty for `unmatched`, which the UI names. */
  label: string;
  colour: string;
  count: number;
  action: LensAction | "ghost" | "keep";
};

export type LensResult = { view: LensView; legend: LensLegendEntry[] };

export const UNMATCHED_ID = "unmatched";

export function evaluateLens(
  lens: Lens,
  input: LensInput,
  /** Legend entries the user switched off: their elements are hidden. */
  hiddenLegend: ReadonlySet<string> = new Set(),
): LensResult {
  const view: LensView = { colours: new Map(), hidden: new Set(), translucent: new Set() };
  const legend: LensLegendEntry[] = [];
  const assigned = new Set<RefKey>();

  const apply = (ref: RefKey, id: string, action: LensAction, colour: string) => {
    assigned.add(ref);
    if (hiddenLegend.has(id) || action === "hide") {
      view.hidden.add(ref);
      return;
    }
    view.colours.set(ref, colour);
    if (action === "transparent") view.translucent.add(ref);
  };

  if (lens.kind === "rules" && input.kind === "rules") {
    const rules = new Map(lens.rules.map((rule) => [rule.id, rule]));
    // The first rule an element matches decides it.
    for (const { ruleId, refs } of input.matches) {
      const rule = rules.get(ruleId);
      if (!rule || !rule.enabled) continue;
      let count = 0;
      for (const ref of refs) {
        if (assigned.has(ref)) continue;
        apply(ref, rule.id, rule.action, rule.colour);
        count += 1;
      }
      legend.push({ id: rule.id, label: rule.name, colour: rule.colour, count, action: rule.action });
    }
  } else if (lens.kind === "auto" && input.kind === "auto") {
    // Largest first, so the commonest values get the clearest colours; an
    // element with two values (a wall in two classification systems) takes
    // the larger group's.
    const groups = [...input.groups].sort(
      (a, b) => b.refs.length - a.refs.length || a.value.localeCompare(b.value),
    );
    groups.forEach((group, index) => {
      const id = `value:${group.value}`;
      const colour = paletteColour(index);
      let count = 0;
      for (const ref of group.refs) {
        if (assigned.has(ref)) continue;
        apply(ref, id, "colour", colour);
        count += 1;
      }
      if (count > 0) legend.push({ id, label: group.value, colour, count, action: "colour" });
    });
  }

  let unmatched = 0;
  for (const ref of input.universe) {
    if (assigned.has(ref)) continue;
    unmatched += 1;
    if (hiddenLegend.has(UNMATCHED_ID) || lens.unmatched === "hide") view.hidden.add(ref);
    else if (lens.unmatched === "ghost") {
      view.colours.set(ref, GHOST_COLOUR);
      view.translucent.add(ref);
    }
  }
  if (unmatched > 0) {
    legend.push({
      id: UNMATCHED_ID,
      label: "",
      colour: GHOST_COLOUR,
      count: unmatched,
      action: lens.unmatched === "ghost" ? "ghost" : lens.unmatched === "hide" ? "hide" : "keep",
    });
  }
  return { view, legend };
}
