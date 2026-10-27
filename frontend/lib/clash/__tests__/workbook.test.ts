// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EMPTY_ELEMENT_FILTER } from "@/lib/ifc/types";
import { emptyMatrix, findRule, newGroup, setRule } from "../matrix";
import type { ClashGroup, ClashMatrix } from "../types";
import { createClashWorkbook, readClashWorkbook } from "../workbook";

describe("clash workbook", () => {
  it("round-trips a group filtered by classification, and leaves one without it empty", () => {
    const classified: ClashGroup = {
      ...newGroup("Framed walls"),
      filter: {
        ...EMPTY_ELEMENT_FILTER,
        classes: ["IfcWall*"],
        classificationSystem: "Uniclass 2015",
        classificationCodes: ["Ss_25_10_30", "Ss_25_10_60"],
      },
    };
    const plain: ClashGroup = {
      ...newGroup("Ducts"),
      filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcDuct*"] },
    };

    const back = readClashWorkbook(
      createClashWorkbook({ ...emptyMatrix(), groups: [classified, plain] }),
    );

    expect(back.groups[0].filter).toMatchObject({
      classes: ["IfcWall*"],
      classificationSystem: "Uniclass 2015",
      classificationCodes: ["Ss_25_10_30", "Ss_25_10_60"],
    });
    // A group that names no classification must not gain one, or it would
    // select nothing on the next run.
    expect(back.groups[1].filter.classificationSystem).toBe("");
    expect(back.groups[1].filter.classificationCodes).toEqual([]);
  });

  it("round-trips groups, filters, tolerances, cells and settings", () => {
    const base = emptyMatrix();
    const walls: ClashGroup = {
      ...newGroup("Walls"),
      discipline: "Architectural",
      filter: {
        classes: ["IfcWall*"],
        names: [],
        predefinedTypes: ["SOLIDWALL"],
        objectTypes: [],
        materials: ["Concrete*"],
        materialCategories: ["Concrete"],
        propertyCombination: "any" as const,
        properties: [
          { setName: "Pset_WallCommon", propertyName: "IsExternal", operator: "equals" as const, value: "TRUE" },
          { setName: "Pset_WallCommon", propertyName: "FireRating", operator: "exists" as const, value: "" },
        ],
      },
    };
    const ducts: ClashGroup = {
      ...newGroup("Ducts"),
      discipline: "MEP",
      filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcDuct*"] },
    };
    let matrix: ClashMatrix = { ...base, groups: [walls, ducts] };
    matrix = setRule(matrix, walls.id, ducts.id, matrix.tolerances[1].id);
    matrix = setRule(matrix, walls.id, walls.id, matrix.tolerances[0].id);
    matrix = {
      ...matrix,
      tolerances: matrix.tolerances.map((t, i) => (i === 0 ? { ...t, useVolume: true, volume: 0.02 } : t)),
      settings: { ...matrix.settings, checkInside: false, ignoreSameModel: true },
    };

    const back = readClashWorkbook(createClashWorkbook(matrix));

    expect(back.groups.map((g) => g.name)).toEqual(["Walls", "Ducts"]);
    expect(back.groups[0].discipline).toBe("Architectural");
    expect(back.groups[0].filter).toMatchObject({
      classes: ["IfcWall*"],
      predefinedTypes: ["SOLIDWALL"],
      materials: ["Concrete*"],
      materialCategories: ["Concrete"],
      propertyCombination: "any",
    });
    expect(back.groups[0].filter.properties).toEqual(walls.filter.properties);
    expect(back.tolerances.map((t) => t.name)).toEqual(matrix.tolerances.map((t) => t.name));
    expect(back.tolerances[1]).toMatchObject({ mode: "clearance", clearance: 0.05, useVolume: false });
    expect(back.tolerances[0]).toMatchObject({ useVolume: true, volume: 0.02 });
    expect(back.rules).toHaveLength(2);
    const cross = findRule(back, back.groups[0].id, back.groups[1].id);
    expect(back.tolerances.find((t) => t.id === cross?.toleranceId)?.name).toBe("Clearance 50 mm");
    expect(back.settings).toMatchObject({
      checkInside: false,
      ignoreSameModel: true,
      ignoreSameDiscipline: false,
      checkDuplicate: true,
    });
  });

  const EXAMPLE = "/Users/josegranja/Downloads/Clash Detection Matrix Report.xlsx";
  it.skipIf(!existsSync(EXAMPLE))("reads a Solibri clash detection matrix", () => {
    const matrix = readClashWorkbook(new Uint8Array(readFileSync(EXAMPLE)));
    expect(matrix.groups.length).toBeGreaterThan(50);
    expect(matrix.groups[0]).toMatchObject({ discipline: "Architectural" });
    expect(matrix.groups[0].filter.classes).toEqual(["IfcBeam*"]);
    expect(matrix.tolerances.map((t) => t.name)).toContain("G");
    expect(matrix.tolerances.find((t) => t.name === "G")).toMatchObject({
      horizontal: 0.01,
      vertical: 0.01,
      useVolume: false,
      volume: 0.01,
    });
    expect(matrix.rules.length).toBeGreaterThan(1000);
    // "IfcColumn*" × "IfcBeam*" is marked in the sheet.
    const beam = matrix.groups.find((g) => g.filter.classes[0] === "IfcBeam*" && g.discipline === "Architectural")!;
    const column = matrix.groups.find((g) => g.filter.classes[0] === "IfcColumn*" && g.discipline === "Architectural")!;
    expect(findRule(matrix, beam.id, column.id)).toBeDefined();
    expect(matrix.settings).toMatchObject({ checkDuplicate: true, checkInside: true, checkOverlap: true });
  });
});

/** Ids are minted on read, so they are left out of the comparison. */
function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...value };
  delete copy.id;
  return copy as Omit<T, "id">;
}

describe("the workbook as a project's clash matrix", () => {
  // A project folder stores the matrix only as this workbook, so reading it
  // back has to give the same matrix, not a close one.
  it("gives back exactly the matrix it was written from", () => {
    const filter = {
      ...EMPTY_ELEMENT_FILTER,
      classes: ["IfcWall*", "/^IfcCurtain(Wall|Panel)$/"],
      // A regex may hold a comma, and an object type " / ".
      names: ["/^Bloco (A|B), piso \\d+$/"],
      objectTypes: ["Wall / Exterior"],
      materials: ["Concrete*"],
      materialCategories: ["Concrete"],
      classificationSystem: "Uniclass 2015",
      classificationCodes: ["Ss_25*", "Ss_30_10_30"],
      propertyCombination: "any" as const,
      properties: [
        { setName: "Pset_WallCommon", propertyName: "FireRating", operator: "equals" as const, value: "REI 60" },
        { setName: "Pset_WallCommon", propertyName: "IsExternal", operator: "exists" as const, value: "" },
      ],
    };
    const first: ClashGroup = { ...newGroup("Walls"), discipline: "ARQ", note: "Check the façade.", filter };
    // Same name as the first: a duplicated group starts that way.
    const second: ClashGroup = {
      ...newGroup("Walls"),
      discipline: "EST",
      filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcColumn"] },
    };
    let matrix: ClashMatrix = { ...emptyMatrix(), groups: [first, second] };
    matrix = setRule(matrix, first.id, second.id, matrix.tolerances[1].id);
    matrix = {
      ...matrix,
      settings: { ...matrix.settings, ignoreSameModel: true, ignoreSameDiscipline: true, checkDuplicate: false },
    };

    const back = readClashWorkbook(createClashWorkbook(matrix));

    // A rule is unordered (A×B is B×A), and an absent optional filter field
    // means the same as an empty one.
    const shape = (m: ClashMatrix) => ({
      groups: m.groups.map((group) => ({
        ...withoutId(group),
        filter: { classificationSystem: "", classificationCodes: [], propertyCombination: "all", ...group.filter },
      })),
      tolerances: m.tolerances.map(withoutId),
      rules: m.rules.map((rule) => {
        const pair = [rule.a, rule.b].map((id) => m.groups.findIndex((group) => group.id === id)).sort();
        return { pair, tolerance: m.tolerances.find((tolerance) => tolerance.id === rule.toleranceId)?.name };
      }),
      settings: { ...m.settings, maxClashes: undefined },
    });
    expect(shape(back)).toEqual(shape(matrix));
  });
});

describe("the workbook's model disciplines", () => {
  it("are written to a Models sheet and read back", () => {
    const matrix = {
      ...emptyMatrix(),
      groups: [{ ...newGroup("Walls"), discipline: "Architecture", filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcWall*"] } }],
      modelDisciplines: { "Hospital ARQ.ifc": "Architecture", "Hospital EST.ifc": "Structure" },
    };
    expect(readClashWorkbook(createClashWorkbook(matrix)).modelDisciplines).toEqual(matrix.modelDisciplines);
  });

  it("are none when the workbook has no Models sheet, as a Solibri one does not", () => {
    const withModels = createClashWorkbook({
      ...emptyMatrix(),
      groups: [{ ...newGroup("Walls"), filter: { ...EMPTY_ELEMENT_FILTER, classes: ["IfcWall*"] } }],
    });
    expect(readClashWorkbook(withModels).modelDisciplines).toEqual({});
  });
});
