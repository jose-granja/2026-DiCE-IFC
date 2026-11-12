import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getClassPredefinedTypes,
  getClassProperties,
  getPropertyAllowedValues,
  idsDataType,
  isUnmappedNumeric,
} from "../client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The bSDD → IDS data type mapping.
 *
 * This is a small function guarding a large failure. IDS matches a property by
 * its measure type, so a facet carrying the wrong `dataType` matches no
 * elements at all — and a specification that applies to nothing is reported as
 * a pass. Suggesting a wrong type is therefore worse than suggesting none.
 */
describe("idsDataType", () => {
  it("maps the types bSDD states unambiguously", () => {
    expect(idsDataType("String")).toBe("IFCLABEL");
    expect(idsDataType("Boolean")).toBe("IFCBOOLEAN");
    expect(idsDataType("Integer")).toBe("IFCINTEGER");
    expect(idsDataType("Time")).toBe("IFCDATETIME");
  });

  it("refuses to guess a measure for Real", () => {
    // bSDD calls 110 of IfcWall's 233 properties "Real", spanning
    // IfcThermalTransmittanceMeasure, IfcPositiveLengthMeasure and others.
    // IFCREAL is right for almost none of them, and wrong silently.
    expect(idsDataType("Real")).toBeUndefined();
    expect(isUnmappedNumeric("Real")).toBe(true);
  });

  it("returns nothing for a type it does not know", () => {
    expect(idsDataType(undefined)).toBeUndefined();
    expect(idsDataType("Complex")).toBeUndefined();
    expect(isUnmappedNumeric("String")).toBe(false);
  });
});

describe("getClassProperties", () => {
  it("uses the dedicated properties endpoint instead of the rate-limited class option", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          classProperties: [
            {
              name: "Fire Rating",
              uri: "https://example.test/class/IfcWall/prop/FireRating",
              propertyCode: "FireRating",
              propertySet: "Pset_WallCommon",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const classUri =
      "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall";
    const properties = await getClassProperties(classUri);

    expect(properties).toHaveLength(1);
    expect(properties[0]?.propertyCode).toBe("FireRating");
    expect(fetchMock).toHaveBeenCalledOnce();

    const requestUrl = new URL(
      fetchMock.mock.calls[0]?.[0] as string,
      "http://localhost",
    );
    expect(requestUrl.searchParams.get("path")).toBe(
      "/api/Class/Properties/v1",
    );
    expect(requestUrl.searchParams.get("ClassUri")).toBe(classUri);
    expect(requestUrl.searchParams.get("Limit")).toBe("1000");
    expect(requestUrl.searchParams.has("IncludeClassProperties")).toBe(false);
  });
});

describe("getClassPredefinedTypes", () => {
  it("extracts IFC enum children and ignores ordinary subtypes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          referenceCode: "IfcWall",
          childClassReferences: [
            { code: "IfcWallSHEAR", uri: "https://example.test/SHEAR" },
            { code: "IfcWallSOLIDWALL", uri: "https://example.test/SOLIDWALL" },
            {
              code: "IfcWallStandardCase",
              uri: "https://example.test/IfcWallStandardCase",
            },
            { code: "IfcSlab", uri: "https://example.test/IfcSlab" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const values = await getClassPredefinedTypes(
      "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall",
      "IFCWALL",
    );

    expect(values).toEqual(["SHEAR", "SOLIDWALL"]);
    const requestUrl = new URL(
      fetchMock.mock.calls[0]?.[0] as string,
      "http://localhost",
    );
    expect(requestUrl.searchParams.get("path")).toBe("/api/Class/v1");
    expect(requestUrl.searchParams.get("IncludeChildClassReferences")).toBe(
      "true",
    );
    expect(requestUrl.searchParams.has("IncludeClassProperties")).toBe(false);
  });
});

describe("getPropertyAllowedValues", () => {
  it("reads a property's values from its dictionary-level definition", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      code: "Status",
      allowedValues: [
        { code: "NEW", value: "NEW" },
        { code: "EXISTING", value: "EXISTING" },
        { code: "", value: "" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const uri = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/prop/Status";
    const values = await getPropertyAllowedValues(uri);

    expect(values.map((value) => value.code)).toEqual(["NEW", "EXISTING"]);
    const requested = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://localhost");
    expect(requested.pathname).toBe("/api/bsdd");
    expect(requested.searchParams.get("path")).toBe("/api/Property/v4");
    expect(requested.searchParams.get("uri")).toBe(uri);
  });
});
