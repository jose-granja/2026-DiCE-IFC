import { describe, expect, it } from "vitest";

import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";

import { LENS_FILE_FORMAT, LensFileError, parseLensFile, serializeLenses } from "../file";
import { BUILTIN_LENSES } from "../presets";
import type { Lens } from "../types";

const walls: Lens = {
  id: "lens-walls",
  name: "Walls in red",
  kind: "rules",
  unmatched: "hide",
  rules: [
    {
      id: "rule-1",
      name: "Walls",
      enabled: true,
      filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcWall"] },
      action: "colour",
      colour: "#ff0000",
    },
  ],
};
const storeys: Lens = {
  id: "lens-storeys",
  name: "Storeys",
  kind: "auto",
  source: { kind: "storey" },
  unmatched: "keep",
};

function errorCode(text: string) {
  try {
    parseLensFile(text);
  } catch (error) {
    return error instanceof LensFileError ? error.code : "other";
  }
  return null;
}

describe("a lens list file", () => {
  it("reads back exactly the lenses that were written", () => {
    const read = parseLensFile(serializeLenses([walls, storeys], "lens-storeys"));
    expect(read).toEqual({ lenses: [walls, storeys], activeId: "lens-storeys", skipped: 0 });
  });

  it("leaves the built-ins out, since every copy of the app has them", () => {
    const text = serializeLenses([BUILTIN_LENSES[0], walls]);
    expect(JSON.parse(text).lenses.map((lens: Lens) => lens.id)).toEqual(["lens-walls"]);
  });

  it("will not let a file pass a lens off as built-in", () => {
    const text = JSON.stringify({
      format: LENS_FILE_FORMAT,
      version: 1,
      lenses: [{ ...walls, builtin: true }],
    });
    expect(parseLensFile(text).lenses[0]).not.toHaveProperty("builtin");
  });

  it("keeps the readable lenses and counts the rest", () => {
    const text = JSON.stringify({
      format: LENS_FILE_FORMAT,
      version: 1,
      lenses: [
        walls,
        { ...storeys, kind: "nonsense" },
        { ...walls, id: "bad-colour", rules: [{ ...walls.rules[0], colour: "red" }] },
      ],
    });
    const read = parseLensFile(text);
    expect(read.lenses.map((lens) => lens.id)).toEqual(["lens-walls"]);
    expect(read.skipped).toBe(2);
  });

  it("refuses what is not a lens list, naming why", () => {
    expect(errorCode("not json")).toBe("notJson");
    expect(errorCode(JSON.stringify({ format: "dice-ifc-project", version: 1 }))).toBe("notLensFile");
    expect(errorCode(JSON.stringify([walls]))).toBe("notLensFile");
    expect(errorCode(JSON.stringify({ format: LENS_FILE_FORMAT, version: 2, lenses: [] }))).toBe(
      "newerVersion",
    );
  });
});
