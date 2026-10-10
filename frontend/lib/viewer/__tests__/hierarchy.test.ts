import { describe, expect, it } from "vitest";

import type { SpatialNodeView } from "@/lib/ifc/types";
import { subtreeRefs } from "../hierarchy";

const tree: SpatialNodeView = {
  expressId: 1,
  type: "IfcBuildingStorey",
  name: "Level 0",
  elementIds: [10, 11],
  children: [
    {
      expressId: 2,
      type: "IfcSpace",
      name: "Room A",
      elementIds: [11, 12],
      children: [],
    },
  ],
};

describe("subtreeRefs", () => {
  it("includes spatial nodes and all nested elements without duplicates", () => {
    expect(subtreeRefs(tree, "model-a")).toEqual([
      { modelId: "model-a", expressId: 10 },
      { modelId: "model-a", expressId: 11 },
      { modelId: "model-a", expressId: 2 },
      { modelId: "model-a", expressId: 12 },
      { modelId: "model-a", expressId: 1 },
    ]);
  });

  it("puts the clicked node's own ref last, so the property panel reads that node", () => {
    // `selection.at(-1)` is what the property panel shows. Clicking a storey
    // must leave the storey's own ref there, not some element or nested space
    // that traversal happened to visit last.
    const refs = subtreeRefs(tree, "model-a");
    expect(refs.at(-1)).toEqual({ modelId: "model-a", expressId: 1 });
  });

  it("still puts a nested space's own ref last when the space itself is clicked", () => {
    const space = tree.children[0];
    expect(subtreeRefs(space, "model-a")).toEqual([
      { modelId: "model-a", expressId: 11 },
      { modelId: "model-a", expressId: 12 },
      { modelId: "model-a", expressId: 2 },
    ]);
  });
});
