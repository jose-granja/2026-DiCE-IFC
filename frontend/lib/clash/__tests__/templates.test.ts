// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { findRule, sanitiseMatrix } from "../matrix";
import { buildTemplate, residentialMatrix } from "../templates";
import { createClashWorkbook, readClashWorkbook } from "../workbook";
import { compileElementFilter, matchesClass } from "@/lib/ifc/element-filter";

const label = (key: string) => key;

describe("the residential template", () => {
  const matrix = residentialMatrix(label);
  const group = (key: string) => matrix.groups.find((g) => g.id === `tpl-${key}`)!;
  const classesOf = (key: string) => compileElementFilter(group(key).filter);

  it("covers architecture, structure and the three services", () => {
    expect(new Set(matrix.groups.map((g) => g.discipline))).toEqual(
      new Set(["disciplines.architecture", "disciplines.structure", "disciplines.mep"]),
    );
    expect(matrix.groups.length).toBeGreaterThanOrEqual(12);
  });

  it("is a valid matrix: every cell names real groups and a real tolerance", () => {
    const groupIds = new Set(matrix.groups.map((g) => g.id));
    const toleranceIds = new Set(matrix.tolerances.map((t) => t.id));
    for (const rule of matrix.rules) {
      expect(groupIds.has(rule.a), rule.a).toBe(true);
      expect(groupIds.has(rule.b), rule.b).toBe(true);
      expect(toleranceIds.has(rule.toleranceId), rule.toleranceId).toBe(true);
    }
    // Nothing is lost on the way through the sanitiser that stored matrices use.
    expect(sanitiseMatrix(matrix).rules).toHaveLength(matrix.rules.length);
  });

  it("has one cell per pair, whichever way round it was written", () => {
    const keys = matrix.rules.map((r) => [r.a, r.b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tests what a coordinator expects, and not what is simply how a building is built", () => {
    const hard = (a: string, b: string) => findRule(matrix, `tpl-${a}`, `tpl-${b}`);
    expect(hard("pipes", "beams")).toBeDefined();
    expect(hard("ducts", "columns")).toBeDefined();
    expect(hard("ducts", "pipes")?.toleranceId).toBe("tpl-clearance50");
    // Walls rest on slabs and doors sit in walls: neither is a clash.
    expect(hard("walls", "floorsRoofs")).toBeUndefined();
    expect(hard("doors", "walls")).toBeUndefined();
  });

  it("selects the classes it names, subtypes included, and nothing it does not", () => {
    expect(matchesClass(classesOf("walls"), "IfcWallStandardCase")).toBe(true);
    expect(matchesClass(classesOf("walls"), "IfcWall")).toBe(true);
    expect(matchesClass(classesOf("walls"), "IfcSlab")).toBe(false);
    expect(matchesClass(classesOf("pipes"), "IfcPipeSegment")).toBe(true);
    expect(matchesClass(classesOf("pipes"), "IfcPipeFitting")).toBe(true);
    expect(matchesClass(classesOf("pipes"), "IfcDuctSegment")).toBe(false);
    expect(matchesClass(classesOf("terminals"), "IfcLightFixture")).toBe(true);
  });

  it("puts no class in two groups of the same discipline", () => {
    const sample = [
      "IfcWall", "IfcSlab", "IfcRoof", "IfcDoor", "IfcWindow", "IfcStair", "IfcCovering",
      "IfcColumn", "IfcBeam", "IfcFooting", "IfcPile", "IfcDuctSegment", "IfcPipeSegment",
      "IfcCableCarrierSegment", "IfcFlowTerminal", "IfcPump", "IfcLightFixture",
    ];
    for (const type of sample) {
      const owners = matrix.groups.filter((g) => matchesClass(compileElementFilter(g.filter), type));
      // A pump is in no group by class (it is IfcPump, not IfcFlowMovingDevice) — that is
      // a gap worth knowing about, so it is only asserted that nothing is claimed twice.
      expect(owners.length, type).toBeLessThanOrEqual(1);
    }
  });

  it("ignores clashes inside one model, as a federation of disciplines wants", () => {
    expect(matrix.settings.ignoreSameModel).toBe(true);
  });

  it("survives a round trip through the Excel workbook it will be exported to", () => {
    const back = readClashWorkbook(createClashWorkbook(matrix));
    expect(back.groups.map((g) => g.name)).toEqual(matrix.groups.map((g) => g.name));
    expect(back.groups[0].filter.classes).toEqual(matrix.groups[0].filter.classes);
    expect(back.rules).toHaveLength(matrix.rules.length);
    expect(back.tolerances.map((t) => t.name)).toEqual(matrix.tolerances.map((t) => t.name));
    expect(back.settings.ignoreSameModel).toBe(true);
  });

  it("is reachable by id", () => {
    expect(buildTemplate("residential", label).groups).toHaveLength(matrix.groups.length);
  });
});
