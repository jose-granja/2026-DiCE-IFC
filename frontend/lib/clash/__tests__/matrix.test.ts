import { describe, expect, it } from "vitest";

import {
  disciplineAllows,
  emptyMatrix,
  findRule,
  modelDiscipline,
  newGroup,
  removeGroup,
  removeTolerance,
  ruleKey,
  sanitiseMatrix,
  setRule,
} from "../matrix";

describe("the clash matrix", () => {
  it("treats A×B and B×A as one cell", () => {
    expect(ruleKey("a", "b")).toBe(ruleKey("b", "a"));
    const matrix = emptyMatrix();
    const a = newGroup("A");
    const b = newGroup("B");
    const withRule = setRule({ ...matrix, groups: [a, b] }, a.id, b.id, matrix.tolerances[0].id);
    expect(findRule(withRule, b.id, a.id)?.toleranceId).toBe(matrix.tolerances[0].id);

    // Setting it again from the other side replaces it rather than doubling it.
    const again = setRule(withRule, b.id, a.id, matrix.tolerances[1].id);
    expect(again.rules).toHaveLength(1);
    expect(findRule(again, a.id, b.id)?.toleranceId).toBe(matrix.tolerances[1].id);
  });

  it("clears a cell", () => {
    const matrix = emptyMatrix();
    const a = newGroup("A");
    const b = newGroup("B");
    const set = setRule({ ...matrix, groups: [a, b] }, a.id, b.id, matrix.tolerances[0].id);
    expect(setRule(set, a.id, b.id, null).rules).toHaveLength(0);
  });

  it("drops a group's cells with it", () => {
    const matrix = emptyMatrix();
    const [a, b, c] = [newGroup("A"), newGroup("B"), newGroup("C")];
    let m = { ...matrix, groups: [a, b, c] };
    m = setRule(m, a.id, b.id, matrix.tolerances[0].id);
    m = setRule(m, b.id, c.id, matrix.tolerances[0].id);
    m = removeGroup(m, b.id);
    expect(m.groups.map((g) => g.name)).toEqual(["A", "C"]);
    expect(m.rules).toHaveLength(0);
  });

  it("drops the cells that used a removed tolerance", () => {
    const matrix = emptyMatrix();
    const [a, b] = [newGroup("A"), newGroup("B")];
    const m = setRule({ ...matrix, groups: [a, b] }, a.id, b.id, matrix.tolerances[0].id);
    const out = removeTolerance(m, matrix.tolerances[0].id);
    expect(out.rules).toHaveLength(0);
    expect(out.tolerances).toHaveLength(1);
  });

  it("repairs a stored matrix rather than trusting it", () => {
    const a = newGroup("A");
    const cleaned = sanitiseMatrix({
      groups: [a, { nope: true }],
      tolerances: [{ id: "t", name: "T", mode: "hard", horizontal: 0, vertical: 0, clearance: 0 }],
      rules: [
        { a: a.id, b: a.id, toleranceId: "t" },
        { a: a.id, b: "ghost", toleranceId: "t" },
        { a: a.id, b: a.id, toleranceId: "ghost" },
      ],
    });
    expect(cleaned.groups).toHaveLength(1);
    expect(cleaned.rules).toHaveLength(1);
    expect(cleaned.settings.maxClashes).toBeGreaterThan(0);
    expect(sanitiseMatrix(null).groups).toEqual([]);
  });
});

describe("models classified by discipline", () => {
  it("keep a group to its own discipline's models, once both say one", () => {
    expect(disciplineAllows("Structure", "Structure")).toBe(true);
    // Written by different hands: case and spaces do not matter.
    expect(disciplineAllows(" structure ", "STRUCTURE")).toBe(true);
    expect(disciplineAllows("Structure", "Architecture")).toBe(false);
  });

  it("change nothing until there is something on both sides", () => {
    // An unclassified model is tested by every group…
    expect(disciplineAllows("Structure", "")).toBe(true);
    expect(disciplineAllows("Structure", undefined)).toBe(true);
    // …and a group with no discipline picks from every model.
    expect(disciplineAllows(undefined, "Architecture")).toBe(true);
    expect(disciplineAllows("", "Architecture")).toBe(true);
  });

  it("are read back clean from storage, by model name", () => {
    const matrix = sanitiseMatrix({
      ...emptyMatrix(),
      modelDisciplines: { "ARQ.ifc": " Architecture ", "EST.ifc": "", "": "MEP", "MEP.ifc": 7 },
    });
    expect(matrix.modelDisciplines).toEqual({ "ARQ.ifc": "Architecture" });
    expect(modelDiscipline(matrix, "ARQ.ifc")).toBe("Architecture");
    expect(modelDiscipline(matrix, "unknown.ifc")).toBe("");
    // A matrix saved before disciplines existed has none.
    expect(sanitiseMatrix({ ...emptyMatrix(), modelDisciplines: undefined }).modelDisciplines).toEqual({});
  });
});
