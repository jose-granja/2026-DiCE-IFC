import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetPropertyNames,
  isStandardSet,
  loadPropertyNames,
  propertyLabel,
  propertyNameLanguage,
  propertyNamesUrl,
} from "../property-names";

const table = {
  version: 1,
  language: "pt-PT",
  dictionary: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3",
  updatedAt: "2026-11-12T10:00:00Z",
  names: { FireRating: "Classe de Resistência ao Fogo" },
};

afterEach(() => {
  forgetPropertyNames();
  vi.unstubAllGlobals();
});

describe("loadPropertyNames", () => {
  it("reads bSDD's names through this app's server, naming only the language", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(table)));
    vi.stubGlobal("fetch", fetchMock);
    const found = await loadPropertyNames("pt-PT");
    expect(found?.names.get("FireRating")).toBe("Classe de Resistência ao Fogo");
    expect(propertyNamesUrl("pt-PT")).toBe("/api/bsdd/property-names?language=pt-PT");
    expect(fetchMock).toHaveBeenCalledWith(propertyNamesUrl("pt-PT"), expect.objectContaining({ credentials: "same-origin" }));
  });

  it.each([
    ["bSDD unreachable", async () => new Response("{}", { status: 502 })],
    ["no server", async () => { throw new TypeError("Failed to fetch"); }],
    ["an answer that is not a table", async () => new Response(JSON.stringify({ version: 1, names: "x" }))],
    ["another language's table", async () => new Response(JSON.stringify({ ...table, language: "pt-BR" }))],
  ])("has none with %s, and asks again next time", async (_, answer) => {
    const fetchMock = vi.fn(answer);
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadPropertyNames("pt-PT")).toBeNull();
    await loadPropertyNames("pt-PT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks once per page when it has them", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(table)));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([loadPropertyNames("pt-PT"), loadPropertyNames("pt-PT")]);
    await loadPropertyNames("pt-PT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("labels", () => {
  const table = { language: "pt-PT", updatedAt: "", names: new Map([["FireRating", "Classe de Resistência ao Fogo"], ["Status", "Estado"]]) };

  it("only in Portuguese: English names are the IFC ones", () => {
    expect(propertyNameLanguage("pt")).toBe("pt-PT");
    expect(propertyNameLanguage("en")).toBeNull();
  });

  it("only for buildingSMART's own sets", () => {
    expect(propertyLabel(table, "Pset_WallCommon", "FireRating")).toBe("Classe de Resistência ao Fogo");
    expect(propertyLabel(table, "Qto_WallBaseQuantities", "Status")).toBe("Estado");
    expect(propertyLabel(table, "Acme_Wall", "Status")).toBeUndefined();
    expect(propertyLabel(table, "PSet_Revit_Other", "Status")).toBeUndefined();
    expect(propertyLabel(table, undefined, "Status")).toBeUndefined();
    expect(propertyLabel(table, "Pset_WallCommon", "Unknown")).toBeUndefined();
    expect(propertyLabel(null, "Pset_WallCommon", "FireRating")).toBeUndefined();
    expect(isStandardSet("Qto_SlabBaseQuantities")).toBe(true);
  });
});
