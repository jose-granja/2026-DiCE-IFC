import { describe, expect, it } from "vitest";

import { classifyMaterial, normaliseMaterialText, surfaceMaterial, surfaceUseFor } from "../classify";

const family = (name: string, category?: string) => classifyMaterial({ name, category })?.id ?? null;

describe("classifyMaterial", () => {
  it("reads English and Portuguese names, accents or not", () => {
    expect(family("Concrete, Cast In Situ")).toBe("concrete");
    expect(family("Betão C25/30")).toBe("concrete");
    expect(family("C30/37")).toBe("concrete");
    expect(family("Aço S275")).toBe("metal");
    expect(family("Steel, Paint Finish, Dark Gray, Matte")).toBe("metal");
    expect(family("Madeira de pinho")).toBe("wood");
    expect(family("wood_mdf_plate")).toBe("wood");
    expect(family("Poplar")).toBe("wood");
    expect(family("Gypsum Wall Board")).toBe("plaster");
    expect(family("Reboco tradicional")).toBe("plaster");
    expect(family("Granite, Cut, Rough")).toBe("stone");
    expect(family("Marble_cANTINA")).toBe("stone");
    expect(family("Calçada portuguesa")).toBe("stone");
    expect(family("Asphalt, Bitumen")).toBe("asphalt");
  });

  it("puts the more particular kind first", () => {
    // A ceramic brick is a brick and a ceramic roof tile is a roof tile, not "ceramic tiles".
    expect(family("Tijolo cerâmico furado 30x20x15")).toBe("brick");
    expect(family("Telha cerâmica")).toBe("roofTiles");
    expect(family("Azulejo cerâmico")).toBe("tiles");
    expect(family("Alvenaria de pedra")).toBe("stoneMasonry");
    expect(family("Bloco de betão")).toBe("block");
  });

  it("never textures glass, insulation, membranes or air — even with a textured word in the name", () => {
    for (const name of ["Glass", "Vidro duplo", "Glass wool", "Lã de rocha", "Rigid insulation", "XPS 60 mm", "Vapour Retarder", "Roofing Felt", "Caixa de ar", "Membrana betuminosa"]) {
      expect(family(name), name).toBeNull();
    }
    // The category does not rescue a name that says it is glass.
    expect(family("Door - Glazing", "Glass")).toBeNull();
  });

  it("falls back to the IFC4 category, and gives up on names that say nothing", () => {
    expect(family("Material 01", "concrete")).toBe("concrete");
    expect(family("Material 01", "gypsum")).toBe("plaster");
    expect(family("Default")).toBeNull();
    expect(family("Door - Panel")).toBeNull();
  });
});

describe("surfaceMaterial", () => {
  it("takes the first material with a kind, in the model's order", () => {
    expect(surfaceMaterial([{ name: "Rigid insulation" }, { name: "Reboco" }, { name: "Tijolo" }])?.material.name).toBe("Reboco");
    expect(surfaceMaterial([{ name: "Glass" }])).toBeNull();
  });
});

describe("surfaceUseFor", () => {
  it("knows floors, walls and roofs from the IFC class", () => {
    expect(surfaceUseFor("IfcSlab")).toBe("floor");
    expect(surfaceUseFor("IfcWallStandardCase")).toBe("wall");
    expect(surfaceUseFor("IfcRoof")).toBe("roof");
    expect(surfaceUseFor("IfcFurnishingElement")).toBeNull();
  });
});

it("normalises case, accents and punctuation", () => {
  expect(normaliseMaterialText("  Betão_Armado (C30/37) ")).toBe("betao armado c30/37");
});
