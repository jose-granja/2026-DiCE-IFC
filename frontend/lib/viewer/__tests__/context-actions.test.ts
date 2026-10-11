import { describe, expect, it } from "vitest";

import type { SpatialNodeView } from "@/lib/ifc/types";
import { parseRefKey, sameClassRefs, sameStoreyRefs, storeyOf } from "../context-actions";

const node = (
  expressId: number,
  type: string,
  name: string,
  elementIds: number[] = [],
  children: SpatialNodeView[] = [],
): SpatialNodeView => ({ expressId, type, name, elementIds, children });

// Project > Site > Building > two storeys, the first with a space holding a chair.
const TREE = node(1, "IfcProject", "P", [], [
  node(2, "IfcSite", "Site", [900], [
    node(3, "IfcBuilding", "B", [], [
      node(10, "IfcBuildingStorey", "Level 0", [100, 101], [
        node(20, "IfcSpace", "Room", [102]),
      ]),
      node(11, "IfcBuildingStorey", "Level 1", [200, 201]),
    ]),
  ]),
]);

const TYPES = new Map<string, string>([
  ["a#100", "IfcWall"],
  ["a#101", "IfcWall"],
  ["a#102", "IfcFurniture"],
  ["a#200", "IfcWall"],
  ["a#201", "IfcSlab"],
  ["a#900", "IfcWall"],
  ["b#5", "IfcWall"],
  ["b#6", "IfcColumn"],
]);

const everything = () => true;

describe("parsing a reference key", () => {
  it("splits on the last #, so a model id may contain one", () => {
    expect(parseRefKey("a#100")).toEqual({ modelId: "a", expressId: 100 });
    expect(parseRefKey("m#1#7")).toEqual({ modelId: "m#1", expressId: 7 });
    expect(parseRefKey("nonsense")).toBeNull();
    expect(parseRefKey("a#x")).toBeNull();
  });
});

describe("selecting everything of the same class", () => {
  it("takes the class from every loaded model, not only the clicked one", () => {
    const refs = sameClassRefs({ modelId: "a", expressId: 100 }, TYPES, everything);
    expect(refs.map((r) => `${r.modelId}#${r.expressId}`).sort()).toEqual(
      ["a#100", "a#101", "a#200", "a#900", "b#5"],
    );
  });

  it("leaves out what is hidden, so the count matches what can be seen", () => {
    const hidden = new Set(["a#101", "b#5"]);
    const refs = sameClassRefs(
      { modelId: "a", expressId: 100 },
      TYPES,
      (ref) => !hidden.has(`${ref.modelId}#${ref.expressId}`),
    );
    expect(refs.map((r) => r.expressId).sort()).toEqual([100, 200, 900]);
  });

  it("falls back to the element itself when its class is not known", () => {
    expect(sameClassRefs({ modelId: "a", expressId: 4242 }, TYPES, everything)).toEqual([
      { modelId: "a", expressId: 4242 },
    ]);
  });
});

describe("selecting everything on the same floor", () => {
  it("finds the storey an element is in, through a space as well as directly", () => {
    expect(storeyOf(TREE, 100)?.storey.name).toBe("Level 0");
    expect(storeyOf(TREE, 102)?.storey.name).toBe("Level 0");
    expect(storeyOf(TREE, 201)?.storey.name).toBe("Level 1");
  });

  it("returns the storey's contents, and only the model's own", () => {
    const result = sameStoreyRefs({ modelId: "a", expressId: 100 }, TREE, TYPES, everything);
    expect(result?.storeyName).toBe("Level 0");
    expect(result?.refs.map((r) => r.expressId).sort()).toEqual([100, 101, 102]);
    expect(result?.refs.every((r) => r.modelId === "a")).toBe(true);
  });

  it("does not select what has no geometry or is hidden", () => {
    const types = new Map(TYPES);
    types.delete("a#102");
    const result = sameStoreyRefs(
      { modelId: "a", expressId: 100 },
      TREE,
      types,
      (ref) => ref.expressId !== 101,
    );
    expect(result?.refs.map((r) => r.expressId)).toEqual([100]);
  });

  it("says there is no floor for an element outside every storey", () => {
    expect(sameStoreyRefs({ modelId: "a", expressId: 900 }, TREE, TYPES, everything)).toBeNull();
    expect(sameStoreyRefs({ modelId: "a", expressId: 100 }, null, TYPES, everything)).toBeNull();
  });
});
