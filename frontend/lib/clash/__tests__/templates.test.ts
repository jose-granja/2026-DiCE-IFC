// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { findRule, sanitiseMatrix } from "../matrix";
import { EIR_DISCIPLINES, eirDiscipline, eirDisciplineCode } from "../disciplines";
import { GROUPS_NEEDING_SETUP, buildTemplate, residentialMatrix } from "../templates";
import { createClashWorkbook, readClashWorkbook } from "../workbook";
import { compileElementFilter, matchesClass, matchesElementFilter } from "@/lib/ifc/element-filter";

const label = (key: string) => key;

describe("the residential template", () => {
  const matrix = residentialMatrix(label);
  const group = (key: string) => matrix.groups.find((g) => g.id === `tpl-${key}`)!;
  const filterOf = (key: string) => compileElementFilter(group(key).filter);
  const rule = (a: string, b: string) => findRule(matrix, `tpl-${a}`, `tpl-${b}`);
  const toleranceOf = (a: string, b: string) => rule(a, b)?.toleranceId.replace("tpl-", "");

  it("has the coordination workbook's 26 groups, each with a discipline of the EIR's Table A.2", () => {
    expect(matrix.groups).toHaveLength(26);
    const names = new Set(EIR_DISCIPLINES.map((d) => d.name));
    for (const g of matrix.groups) expect(names.has(g.discipline!), `${g.id}: ${g.discipline}`).toBe(true);
    expect(new Set(matrix.groups.map((g) => g.discipline)).size).toBe(11);
    expect(group("a01").discipline).toBe("Arquitetura");
    expect(group("s02").discipline).toBe("Engenharia de estruturas");
    expect(group("h01").discipline).toBe("Engenharia mecânica - avac");
    expect(group("z01").discipline).toBe("Multidisciplinar");
    // The same words in either language: they are the EIR's, not translations.
    expect(residentialMatrix((key) => `other:${key}`).groups.map((g) => g.discipline)).toEqual(matrix.groups.map((g) => g.discipline));
  });

  it("has the workbook's 172 tests and the project's 34 between architecture and structure: 206", () => {
    expect(matrix.rules).toHaveLength(206);
    // The project's revision (2026-11-15): architecture and structure against
    // each other, and a group against itself, all hard at 10 mm.
    for (const [a, b] of [["a01", "a01"], ["a01", "a02"], ["a03", "a01"], ["s01", "s02"], ["s03", "a05"], ["s01", "a06"]]) {
      expect(toleranceOf(a, b), `${a}|${b}`).toBe("hard10");
    }
    // Still not tested: e.g. doors against doors, and plant zones against each other.
    expect(rule("a03", "a03")).toBeUndefined();
    expect(rule("z01", "z02")).toBeUndefined();
  });

  it("carries the workbook's tolerances: 5, 10 and 25 mm hard, 50 mm to 600 mm clearance", () => {
    expect(matrix.tolerances.map((t) => [t.id.replace("tpl-", ""), t.mode, t.clearance])).toEqual([
      ["hard5", "hard", 0],
      ["hard10", "hard", 0],
      ["hard25", "hard", 0],
      ["clearance50", "clearance", 0.05],
      ["clearance100", "clearance", 0.1],
      ["clearance150", "clearance", 0.15],
      ["clearance300", "clearance", 0.3],
      ["clearance600", "clearance", 0.6],
    ]);
    expect(matrix.tolerances[0].horizontal).toBeCloseTo(0.005, 6);
  });

  it("uses the tolerance the workbook names for pairs a coordinator would check", () => {
    expect(toleranceOf("h01", "a01")).toBe("hard10"); // duct through a wall
    expect(toleranceOf("p01", "s01")).toBe("hard5"); // domestic pipe through structure
    expect(toleranceOf("p01", "p02")).toBe("clearance50"); // pipe against pipe
    expect(toleranceOf("e02", "p01")).toBe("clearance150"); // electrical board against water
    expect(toleranceOf("c01", "h03")).toBe("clearance100"); // site utilities against heating pipes
    expect(toleranceOf("z01", "a01")).toBe("hard5"); // maintenance zone against a wall
  });

  it("is a valid matrix: every cell names real groups and a real tolerance", () => {
    const groupIds = new Set(matrix.groups.map((g) => g.id));
    const toleranceIds = new Set(matrix.tolerances.map((t) => t.id));
    for (const r of matrix.rules) {
      expect(groupIds.has(r.a), r.a).toBe(true);
      expect(groupIds.has(r.b), r.b).toBe(true);
      expect(toleranceIds.has(r.toleranceId), r.toleranceId).toBe(true);
    }
    expect(sanitiseMatrix(matrix).rules).toHaveLength(matrix.rules.length);
    expect(sanitiseMatrix(matrix).groups.map((g) => g.note)).toEqual(matrix.groups.map((g) => g.note));
  });

  it("has one cell per pair, whichever way round it was written", () => {
    const keys = matrix.rules.map((r) => [r.a, r.b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("selects the classes it names, subtypes included", () => {
    expect(matchesClass(filterOf("a01"), "IfcWallStandardCase")).toBe(true);
    expect(matchesClass(filterOf("a01"), "IfcSlab")).toBe(false);
    expect(matchesClass(filterOf("h03"), "IfcPipeFitting")).toBe(true);
    expect(matchesClass(filterOf("h01"), "IfcPipeSegment")).toBe(false);
    expect(matchesClass(filterOf("e03"), "IfcLightFixture")).toBe(true);
  });

  const facts = (type: string, name = "x", predefinedType = "") => ({
    type,
    name,
    predefinedType,
    objectType: "",
    materials: [],
    materialCategories: [],
    properties: [],
  });

  it("restricts ceilings to the CEILING type, so floor and cladding coverings are not ceilings", () => {
    const ceilings = filterOf("a06");
    expect(matchesElementFilter(ceilings, facts("IfcCovering", "c", "CEILING") as never)).toBe(true);
    expect(matchesElementFilter(ceilings, facts("IfcCovering", "f", "FLOORING") as never)).toBe(false);
  });

  it("selects clearance zones only by name, never every room", () => {
    const maintenance = filterOf("z01");
    expect(matchesElementFilter(maintenance, facts("IfcSpace", "CLZ_MAINT_BOILER") as never)).toBe(true);
    expect(matchesElementFilter(maintenance, facts("IfcSpace", "Living room") as never)).toBe(false);
    expect(matchesElementFilter(filterOf("z02"), facts("IfcBuildingElementProxy", "CLZ_EGRESS_DOOR1") as never)).toBe(true);
  });

  it("flags the groups that share classes and cannot work without a project filter", () => {
    for (const key of ["a01", "a02", "s01", "h03", "p01", "p02", "f01", "c01", "a07", "z01", "z02"]) {
      expect(group(key).note, key).toBe(`notes.${key}`);
      expect(GROUPS_NEEDING_SETUP.has(key)).toBe(true);
    }
    // And only those: a note on every group would be read as a note on none.
    expect(matrix.groups.filter((g) => g.note)).toHaveLength(11);
    // The five pipe groups really do share their classes, which is why they need it.
    const pipes = ["h03", "p01", "p02", "f01"].map((key) => group(key).filter.classes.join());
    expect(new Set(pipes).size).toBe(1);
  });

  it("keeps the workbook's general requirements", () => {
    expect(matrix.settings).toMatchObject({
      checkOverlap: true,
      checkInside: true,
      checkDuplicate: true,
      ignoreSameModel: false,
    });
  });

  it("survives a round trip through the Excel workbook it will be exported to, notes and all", () => {
    const back = readClashWorkbook(createClashWorkbook(matrix));
    expect(back.groups.map((g) => g.name)).toEqual(matrix.groups.map((g) => g.name));
    expect(back.groups[0].filter.classes).toEqual(matrix.groups[0].filter.classes);
    expect(back.groups.find((g) => g.name === "groups.z01")?.filter.names).toEqual(["CLZ_MAINT_*"]);
    expect(back.groups.find((g) => g.name === "groups.a06")?.filter.predefinedTypes).toEqual(["CEILING"]);
    expect(back.groups.find((g) => g.name === "groups.p01")?.note).toBe("notes.p01");
    expect(back.groups.find((g) => g.name === "groups.a03")?.note).toBeUndefined();
    expect(back.rules).toHaveLength(206);
    expect(back.tolerances.map((t) => t.name)).toEqual(matrix.tolerances.map((t) => t.name));
  });

  it("is reachable by id", () => {
    expect(buildTemplate("residential", label).groups).toHaveLength(26);
  });
});

describe("the EIR's disciplines", () => {
  it("are Table A.2: 59 codes, each once, in the EIR's order", () => {
    expect(EIR_DISCIPLINES).toHaveLength(59);
    expect(new Set(EIR_DISCIPLINES.map((d) => d.code)).size).toBe(59);
    expect(EIR_DISCIPLINES[0]).toEqual({ code: "ACS", name: "Acessibilidades" });
    expect(EIR_DISCIPLINES.at(-1)).toEqual({ code: "ZZZ", name: "Multidisciplinar" });
  });

  it("go from code to description and back, ignoring case", () => {
    expect(eirDiscipline("HDR")).toBe("Engenharia hidráulica - drenagem (pluviais e residuais)");
    expect(eirDisciplineCode(" arquitetura ")).toBe("ARQ");
    expect(eirDisciplineCode("Architecture")).toBeUndefined();
    expect(() => eirDiscipline("NOPE")).toThrow();
  });
});
