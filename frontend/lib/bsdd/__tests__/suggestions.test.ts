import { describe, expect, it } from "vitest";

import { merge } from "../suggestions";

describe("merge", () => {
  it("keeps the model's vocabulary first", () => {
    // A property this model demonstrably has beats one a dictionary says it
    // ought to have, so the model's entries lead and bSDD fills in behind.
    expect(merge(["Pset_Custom"], ["Pset_WallCommon"])).toEqual([
      "Pset_Custom",
      "Pset_WallCommon",
    ]);
  });

  it("does not repeat an entry both sources know", () => {
    expect(merge(["Pset_WallCommon"], ["Pset_WallCommon"])).toEqual([
      "Pset_WallCommon",
    ]);
  });

  it("treats case as insignificant when deduplicating", () => {
    // The model reports IFCWALL, bSDD reports IfcWall. Listing both would offer
    // the author a choice that is not a choice.
    expect(merge(["IFCWALL"], ["IfcWall", "IfcSlab"])).toEqual([
      "IFCWALL",
      "IfcSlab",
    ]);
  });
});
