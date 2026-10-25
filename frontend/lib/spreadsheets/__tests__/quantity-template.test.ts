// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDefaultQuantityTemplate } from "../quantity-template";
import { readQuantityWorkbook } from "../quantity-workbook";

const bytes = new Uint8Array(readFileSync(path.resolve("public/templates/mqt-default.xlsx")));

describe("bundled MQT template", () => {
  it("imports through the ordinary Excel reader and has bounded, runnable definitions", () => {
    const ordinary = readQuantityWorkbook(bytes);
    const template = readDefaultQuantityTemplate(bytes, "en");
    expect(template.map(({ level, code, description, query }) => ({ level, code, description, query }))).toEqual(ordinary);
    // A flat list: the template has no chapters.
    expect(new Set(template.map((item) => item.level))).toEqual(new Set([1]));
    expect(template).toHaveLength(12);
    expect(new Set(template.map((item) => item.id)).size).toBe(template.length);
    for (const item of template) {
      expect(item.code).not.toBe("");
      expect(item.description).not.toBe("");
      expect(item.query.filters.classes.length).toBeGreaterThan(0);
      expect(item.query.sources).toHaveLength(1);
      expect(item.query.formula).toBeUndefined();
      expect(item.query.unit).toMatch(/^(m²|m³|un)$/);
    }
    expect(template[0].query).toMatchObject({
      filters: { classes: ["IfcWall", "IfcWallStandardCase", "IfcWallElementedCase"] },
      sources: [{ kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" }],
      unit: "m²",
    });
    expect(template.filter((item) => item.query.sources[0].kind === "count").map((item) => item.code)).toEqual(["MQT.10", "MQT.11", "MQT.12"]);
  });

  it("loads Portuguese descriptions from the same workbook without changing queries or stable IDs", () => {
    const english = readDefaultQuantityTemplate(bytes, "en");
    const portuguese = readDefaultQuantityTemplate(bytes, "pt-PT");
    expect(portuguese[0].description).toBe("Paredes: área lateral líquida");
    expect(english[0].description).toBe("Walls: net side area");
    for (let i = 0; i < english.length; i++) {
      expect(portuguese[i].id).toBe(english[i].id);
      expect(portuguese[i].query).toEqual(english[i].query);
      expect(portuguese[i].description).not.toBe(english[i].description);
    }
  });
});
