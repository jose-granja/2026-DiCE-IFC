/**
 * A lens: a saved way of looking at the federation — what to colour, hide or
 * ghost — as on ifclite.com.
 *
 * Two kinds. **Rules**: an ordered list, each picking elements with the same
 * `ElementFilter` clash groups use and colouring, hiding or turning them
 * translucent; the first rule an element matches decides it. **Auto**: one data
 * source — class, material, storey, a property… — and every distinct value its
 * own colour, with a legend. Either way, what nothing matched is ghosted, kept
 * as it is, or hidden.
 */

import type { ElementFilter, ElementGroupSource } from "@/lib/ifc/types";

export type LensAction = "colour" | "hide" | "transparent";

export type LensRule = {
  id: string;
  name: string;
  enabled: boolean;
  filter: ElementFilter;
  action: LensAction;
  /** CSS hex. Used by `colour` and `transparent`. */
  colour: string;
};

/** `model` needs no worker: every element of a model has that model's name. */
export type LensAutoSource = ElementGroupSource | { kind: "model" };

/** What happens to elements no rule, or no value, picked. */
export type LensUnmatched = "ghost" | "keep" | "hide";

type LensBase = {
  id: string;
  name: string;
  description?: string;
  unmatched: LensUnmatched;
  /** Shipped with the app: not editable, only duplicable, never saved. */
  builtin?: boolean;
};

export type RulesLens = LensBase & { kind: "rules"; rules: LensRule[] };
export type AutoLens = LensBase & { kind: "auto"; source: LensAutoSource };
export type Lens = RulesLens | AutoLens;

/** A reference to an element across the federation — `refKey` in the viewer store. */
export type RefKey = string;
