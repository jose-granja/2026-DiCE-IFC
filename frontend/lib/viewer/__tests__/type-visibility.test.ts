import { describe, expect, it } from "vitest";

import {
  DEFAULT_TYPE_VISIBILITY,
  typeVisibilityCategory,
} from "../type-visibility";

describe("semantic IFC visibility", () => {
  it("uses the requested first-load defaults", () => {
    expect(DEFAULT_TYPE_VISIBILITY).toMatchObject({
      spaces: false,
      spatialZones: true,
      openings: false,
      virtualElements: false,
      site: true,
      annotations: true,
      grids: true,
    });
  });

  it("recognises normalised and STEP-style IFC names", () => {
    expect(typeVisibilityCategory("IfcOpeningElement")).toBe("openings");
    expect(typeVisibilityCategory("IFC_VIRTUAL_ELEMENT")).toBe(
      "virtualElements",
    );
    expect(typeVisibilityCategory("IfcWall")).toBeUndefined();
  });
});
