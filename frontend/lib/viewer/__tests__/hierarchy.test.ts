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
      { modelId: "model-a", expressId: 1 },
      { modelId: "model-a", expressId: 10 },
      { modelId: "model-a", expressId: 11 },
      { modelId: "model-a", expressId: 2 },
      { modelId: "model-a", expressId: 12 },
    ]);
  });
});
