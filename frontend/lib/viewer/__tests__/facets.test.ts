import { describe, expect, it } from "vitest";

import {
  emptySelection,
  hierarchyFacets,
  resolveVisible,
  type ModelFacets,
} from "../facets";

/**
 * How the five filter dimensions combine.
 *
 * Union within a dimension, intersection across them — the rule every faceted
 * filter uses and the one that is easy to write backwards. Intersecting within
 * a dimension would make a second tick narrow to nothing, because an element
 * has exactly one class.
 */

const model: ModelFacets = {
  modelId: "m1",
  hierarchy: [
    { value: "Level 0", expressIds: [1, 2] },
    { value: "Level 1", expressIds: [3, 4] },
  ],
  facets: {
    classes: [
      { value: "IfcWall", expressIds: [1, 3] },
      { value: "IfcSlab", expressIds: [2, 4] },
    ],
    types: [{ value: "Basic Wall 200", expressIds: [1] }],
    materials: [
      { value: "Concrete", expressIds: [1, 2] },
      { value: "Timber", expressIds: [3] },
    ],
    groups: [{ value: "Fire compartment 1", expressIds: [1, 4] }],
  },
};

describe("resolveVisible", () => {
  it("is null when nothing is ticked, rather than hiding everything", () => {
    // The difference between "no filter" and "a filter that matches nothing".
    expect(resolveVisible([model], emptySelection())).toBeNull();
  });

  it("unions within a dimension", () => {
    const selection = emptySelection();
    selection.materials.add("Concrete");
    selection.materials.add("Timber");

    expect(resolveVisible([model], selection)).toEqual(
      new Set(["m1#1", "m1#2", "m1#3"]),
    );
  });

  it("intersects across dimensions", () => {
    // Concrete walls: concrete is {1,2}, walls are {1,3}, so only 1.
    const selection = emptySelection();
    selection.materials.add("Concrete");
    selection.classes.add("IfcWall");

    expect(resolveVisible([model], selection)).toEqual(new Set(["m1#1"]));
  });

  it("treats an untouched dimension as no constraint", () => {
    const selection = emptySelection();
    selection.classes.add("IfcSlab");

    expect(resolveVisible([model], selection)).toEqual(
      new Set(["m1#2", "m1#4"]),
    );
  });

  it("can intersect to nothing, and says so rather than returning null", () => {
    // Timber slabs: there are none. That is a filter matching nothing, which
    // must hide everything — not be mistaken for "no filter".
    const selection = emptySelection();
    selection.materials.add("Timber");
    selection.classes.add("IfcSlab");

    const visible = resolveVisible([model], selection);
    expect(visible).not.toBeNull();
    expect(visible!.size).toBe(0);
  });

  it("combines hierarchy with the other dimensions", () => {
    const selection = emptySelection();
    selection.hierarchy.add("Level 1");
    selection.groups.add("Fire compartment 1");

    // Level 1 is {3,4}; the compartment is {1,4}.
    expect(resolveVisible([model], selection)).toEqual(new Set(["m1#4"]));
  });

  it("keys by model, so two models cannot bleed into each other", () => {
    const second: ModelFacets = { ...model, modelId: "m2" };
    const selection = emptySelection();
    selection.classes.add("IfcWall");

    expect(resolveVisible([model, second], selection)).toEqual(
      new Set(["m1#1", "m1#3", "m2#1", "m2#3"]),
    );
  });
});

describe("hierarchyFacets", () => {
  const tree = {
    name: "Project",
    type: "IfcProject",
    elementIds: [],
    children: [
      {
        name: "Level 0",
        type: "IfcBuildingStorey",
        elementIds: [1],
        children: [
          { name: "Room A", type: "IfcSpace", elementIds: [2], children: [] },
        ],
      },
    ],
  };

  it("counts everything beneath a node, not only what it directly holds", () => {
    // Ticking a storey should keep the storey's rooms and their contents —
    // which is how anyone reads a tree.
    const facets = hierarchyFacets(tree);
    const level = facets.find((f) => f.value === "Level 0")!;
    expect(level.expressIds).toEqual([1, 2]);
  });

  it("skips the root, which is not a filter", () => {
    // Every element is under the project; offering it as a choice would be a
    // tickbox that does nothing.
    expect(hierarchyFacets(tree).map((f) => f.value)).toEqual([
      "Level 0",
      "Room A",
    ]);
  });
});
