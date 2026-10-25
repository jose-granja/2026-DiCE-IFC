import { describe, expect, it } from "vitest";

import {
  groupQuery,
  isGroupQuery,
  newLinePlacement,
  quantityHierarchy,
  quantityLevel,
  visibleQuantityLines,
} from "../quantity-hierarchy";

const measured = {
  ...groupQuery(),
  sources: [{ id: "n", alias: "count", kind: "count" as const }],
};
const line = (id: string, level: number, group = false) => ({ id, level, query: group ? groupQuery() : measured });

// 13 ALVENARIAS
//   13.01 Paredes
//     13.01.01, 13.01.02
//   13.02 (measured, no children)
// 14 (level 1, skips to a level 3 child)
//       14.0.1
const list = [
  line("13", 1, true),
  line("13.01", 2, true),
  line("13.01.01", 3),
  line("13.01.02", 3),
  line("13.02", 2),
  line("14", 1, true),
  line("14.0.1", 3),
];

describe("the quantity hierarchy", () => {
  it("knows each line's parent and how many lines are under it", () => {
    const lines = quantityHierarchy(list);
    expect(lines.map((entry) => entry.parent)).toEqual([null, 0, 1, 1, 0, null, 5]);
    expect(lines.map((entry) => entry.descendants)).toEqual([4, 2, 0, 0, 0, 1, 0]);
  });

  it("hides the branch under a collapsed line, and nothing else", () => {
    const ids = (indices: number[]) => indices.map((index) => list[index].id);
    expect(ids(visibleQuantityLines(list, new Set()))).toEqual(list.map((entry) => entry.id));
    expect(ids(visibleQuantityLines(list, new Set(["13.01"])))).toEqual(["13", "13.01", "13.02", "14", "14.0.1"]);
    // A collapsed line inside a collapsed one changes nothing more.
    expect(ids(visibleQuantityLines(list, new Set(["13", "13.01"])))).toEqual(["13", "14", "14.0.1"]);
    // Collapsing a line with nothing under it hides nothing.
    expect(ids(visibleQuantityLines(list, new Set(["13.02"])))).toEqual(list.map((entry) => entry.id));
  });

  it("puts a new line under a grouping line, after any other line's branch, or at the end", () => {
    expect(newLinePlacement(list, "13.01")).toEqual({ index: 4, level: 3 });
    expect(newLinePlacement(list, "13")).toEqual({ index: 5, level: 2 });
    expect(newLinePlacement(list, "13.01.01")).toEqual({ index: 3, level: 3 });
    expect(newLinePlacement(list, null)).toEqual({ index: 7, level: 1 });
  });

  it("calls a line a grouping line only with no filter and no quantity at all", () => {
    expect(isGroupQuery(groupQuery())).toBe(true);
    expect(isGroupQuery(measured)).toBe(false);
    expect(isGroupQuery({ ...groupQuery(), filters: { ...groupQuery().filters, classes: ["IfcWall"] } })).toBe(false);
    expect(isGroupQuery({ ...groupQuery(), formula: "1" })).toBe(false);
  });

  it("reads a level as a whole number from 1 to 9", () => {
    expect([quantityLevel(undefined), quantityLevel("2"), quantityLevel(0), quantityLevel(14), quantityLevel(2.6)])
      .toEqual([1, 2, 1, 9, 3]);
  });
});
