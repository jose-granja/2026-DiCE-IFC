import { describe, expect, it } from "vitest";

import {
  compileElementFilter,
  isEmptyElementFilter,
  matchesElementFilter,
  type ElementFacts,
} from "../element-filter";
import { EMPTY_ELEMENT_FILTER, type ElementFilter } from "../types";

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  type: "IfcWallStandardCase",
  name: "Basic Wall: Generic - 200mm",
  predefinedType: "SOLIDWALL",
  objectType: "Generic",
  materials: [{ name: "Concrete C30/37", category: "Concrete" }],
  properties: () => [
    { name: "Pset_WallCommon", properties: [{ name: "FireRating", value: "REI 60" }, { name: "IsExternal", value: true }] },
  ],
  ...over,
});

const filter = (over: Partial<ElementFilter>): ElementFilter => ({ ...EMPTY_ELEMENT_FILTER, ...over });
const test = (f: Partial<ElementFilter>, over?: Partial<ElementFacts>) =>
  matchesElementFilter(compileElementFilter(filter(f)), facts(over));

describe("matchesElementFilter", () => {
  it("matches by class, with wildcards", () => {
    expect(test({ classes: ["IfcWall*"] })).toBe(true);
    expect(test({ classes: ["IfcWall"] })).toBe(false);
    expect(test({ classes: ["IfcSlab", "/^IfcWall/"] })).toBe(true);
  });

  it("matches the Name attribute, predefined type and object type", () => {
    expect(test({ names: ["Basic Wall*"] })).toBe(true);
    expect(test({ names: ["Curtain*"] })).toBe(false);
    expect(test({ predefinedTypes: ["solidwall"] })).toBe(true);
    expect(test({ objectTypes: ["Generic"] })).toBe(true);
    expect(test({ objectTypes: ["Custom"] })).toBe(false);
  });

  it("matches material name and material category separately", () => {
    expect(test({ materials: ["Concrete*"] })).toBe(true);
    expect(test({ materialCategories: ["Concrete"] })).toBe(true);
    expect(test({ materialCategories: ["Steel"] })).toBe(false);
    expect(test({ materials: ["Concrete"] })).toBe(false);
    expect(test({ materialCategories: ["Concrete"] }, { materials: [{ name: "Concrete C30/37" }] })).toBe(false);
  });

  it("matches a property in a property set", () => {
    const rule = (value: string, operator: "equals" | "contains" = "equals") => ({
      properties: [{ setName: "Pset_WallCommon", propertyName: "FireRating", operator, value }],
    });
    expect(test(rule("REI 60"))).toBe(true);
    expect(test(rule("/^REI \\d+$/"))).toBe(true);
    expect(test(rule("EI", "contains"))).toBe(true);
    expect(test(rule("REI 90"))).toBe(false);
  });

  it("requires every populated field, and reads properties only when asked", () => {
    let reads = 0;
    const counted = { properties: () => ((reads += 1), []) };
    expect(test({ classes: ["IfcWall*"], materials: ["Steel*"] }, counted)).toBe(false);
    expect(reads).toBe(0);
    expect(
      test({ properties: [{ setName: "A", propertyName: "B", operator: "exists", value: "" }] }, counted),
    ).toBe(false);
    expect(reads).toBe(1);
  });

  it("combines property conditions with ANY when told to", () => {
    const f = {
      propertyCombination: "any" as const,
      properties: [
        { setName: "Pset_WallCommon", propertyName: "Missing", operator: "exists" as const, value: "" },
        { setName: "Pset_WallCommon", propertyName: "IsExternal", operator: "equals" as const, value: "TRUE" },
      ],
    };
    expect(test(f)).toBe(true);
    expect(test({ ...f, propertyCombination: "all" })).toBe(false);
  });

  it("says which pattern is bad", () => {
    expect(() => compileElementFilter(filter({ names: ["/(/"] }))).toThrow(/Invalid regular expression/);
  });
});

describe("isEmptyElementFilter", () => {
  it("treats a blank filter as empty so it cannot select the whole model by accident", () => {
    expect(isEmptyElementFilter(EMPTY_ELEMENT_FILTER)).toBe(true);
    expect(isEmptyElementFilter(filter({ classes: [" "] }))).toBe(true);
    expect(isEmptyElementFilter(filter({ classes: ["*"] }))).toBe(false);
  });
});
