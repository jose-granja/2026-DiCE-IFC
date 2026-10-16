import { describe, expect, it } from "vitest";

import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import { evaluateLens, UNMATCHED_ID } from "../evaluate";
import { GHOST_COLOUR, paletteColour } from "../palette";
import { BUILTIN_LENSES } from "../presets";
import { lensSchema, sanitiseLenses } from "../schema";
import type { AutoLens, RulesLens } from "../types";

const rulesLens = (over: Partial<RulesLens> = {}): RulesLens => ({
  id: "l",
  name: "Test",
  kind: "rules",
  unmatched: "ghost",
  rules: [
    { id: "walls", name: "Walls", enabled: true, filter: EMPTY_ELEMENT_FILTER, action: "colour", colour: "#ff0000" },
    { id: "slabs", name: "Slabs", enabled: true, filter: EMPTY_ELEMENT_FILTER, action: "transparent", colour: "#00ff00" },
    { id: "doors", name: "Doors", enabled: true, filter: EMPTY_ELEMENT_FILTER, action: "hide", colour: "#0000ff" },
  ],
  ...over,
});
const UNIVERSE = ["m#1", "m#2", "m#3", "m#4", "m#5"];

describe("a rules lens", () => {
  it("lets the first matching rule decide each element", () => {
    const { view, legend } = evaluateLens(rulesLens(), {
      kind: "rules",
      universe: UNIVERSE,
      matches: [
        { ruleId: "walls", refs: ["m#1", "m#2"] },
        // m#2 is a wall already; only m#3 is a slab here.
        { ruleId: "slabs", refs: ["m#2", "m#3"] },
        { ruleId: "doors", refs: ["m#4"] },
      ],
    });
    expect(view.colours.get("m#1")).toBe("#ff0000");
    expect(view.colours.get("m#2")).toBe("#ff0000");
    expect(view.colours.get("m#3")).toBe("#00ff00");
    expect(view.translucent.has("m#3")).toBe(true);
    expect(view.hidden.has("m#4")).toBe(true);
    expect(legend.map((entry) => [entry.id, entry.count])).toEqual([
      ["walls", 2],
      ["slabs", 1],
      ["doors", 1],
      [UNMATCHED_ID, 1],
    ]);
  });

  it("ghosts, keeps or hides what no rule picked", () => {
    const input = { kind: "rules" as const, universe: UNIVERSE, matches: [{ ruleId: "walls", refs: ["m#1"] }] };
    const ghost = evaluateLens(rulesLens(), input).view;
    expect(ghost.colours.get("m#5")).toBe(GHOST_COLOUR);
    expect(ghost.translucent.has("m#5")).toBe(true);
    const keep = evaluateLens(rulesLens({ unmatched: "keep" }), input).view;
    expect(keep.colours.has("m#5")).toBe(false);
    expect(keep.hidden.has("m#5")).toBe(false);
    expect(evaluateLens(rulesLens({ unmatched: "hide" }), input).view.hidden.has("m#5")).toBe(true);
  });

  it("skips a rule that is switched off, so the next one can take its elements", () => {
    const lens = rulesLens();
    lens.rules[0].enabled = false;
    const { view } = evaluateLens(lens, {
      kind: "rules",
      universe: UNIVERSE,
      matches: [
        { ruleId: "walls", refs: ["m#2"] },
        { ruleId: "slabs", refs: ["m#2"] },
      ],
    });
    expect(view.colours.get("m#2")).toBe("#00ff00");
  });

  it("hides a legend entry's elements when it is switched off", () => {
    const { view } = evaluateLens(
      rulesLens(),
      { kind: "rules", universe: UNIVERSE, matches: [{ ruleId: "walls", refs: ["m#1"] }] },
      new Set(["walls", UNMATCHED_ID]),
    );
    expect(view.hidden.has("m#1")).toBe(true);
    expect(view.hidden.has("m#5")).toBe(true);
  });
});

describe("an auto-colour lens", () => {
  const auto: AutoLens = { id: "a", name: "By class", kind: "auto", source: { kind: "class" }, unmatched: "ghost" };

  it("gives each value its own colour, the largest group the first", () => {
    const { view, legend } = evaluateLens(auto, {
      kind: "auto",
      universe: UNIVERSE,
      groups: [
        { value: "IfcSlab", refs: ["m#3"] },
        { value: "IfcWall", refs: ["m#1", "m#2"] },
      ],
    });
    expect(legend.map((entry) => [entry.label, entry.count, entry.colour])).toEqual([
      ["IfcWall", 2, paletteColour(0)],
      ["IfcSlab", 1, paletteColour(1)],
      ["", 2, GHOST_COLOUR],
    ]);
    expect(view.colours.get("m#1")).toBe(paletteColour(0));
  });

  it("puts an element with two values in the larger group only", () => {
    const { legend } = evaluateLens(auto, {
      kind: "auto",
      universe: ["m#1", "m#2"],
      groups: [
        { value: "Small", refs: ["m#1"] },
        { value: "Large", refs: ["m#1", "m#2"] },
      ],
    });
    expect(legend.find((entry) => entry.label === "Large")?.count).toBe(2);
    expect(legend.find((entry) => entry.label === "Small")).toBeUndefined();
  });
});

describe("the palette", () => {
  it("never repeats across the first forty groups", () => {
    const colours = Array.from({ length: 40 }, (_, index) => paletteColour(index));
    expect(new Set(colours).size).toBe(40);
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("lenses read from storage", () => {
  it("accepts every built-in", () => {
    for (const lens of BUILTIN_LENSES) expect(lensSchema.safeParse(lens).success, lens.id).toBe(true);
  });

  it("keeps the valid ones and drops the rest", () => {
    const good = BUILTIN_LENSES[0];
    const kept = sanitiseLenses([good, { id: "bad", kind: "rules", rules: [{ colour: "red" }] }, "nonsense"]);
    expect(kept.map((lens) => lens.id)).toEqual([good.id]);
  });
});
