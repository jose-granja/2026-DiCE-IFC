// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { checkDocument, validateAgainstSchema } from "../validate";
import {
  emptyDocument,
  emptySpecification,
  simple,
  type IdsDocument,
  type Specification,
} from "../types";

function documentWith(spec: Partial<Specification> = {}): IdsDocument {
  const document = emptyDocument("Test");
  document.specifications = [
    {
      ...emptySpecification("Walls are named"),
      applicability: {
        facets: [
          { id: "f1", facet: { kind: "entity", name: simple("IFCWALL") } },
        ],
      },
      requirements: [
        {
          id: "r1",
          cardinality: "required",
          facet: { kind: "attribute", name: simple("Name") },
        },
      ],
      ...spec,
    },
  ];
  return document;
}

const messages = (document: IdsDocument) =>
  checkDocument(document).map((issue) => issue.message);

describe("authoring checks", () => {
  it("passes a well-formed document", () => {
    expect(checkDocument(documentWith())).toEqual([]);
  });

  it("requires a document title", () => {
    const document = documentWith();
    document.info.title = "  ";
    expect(messages(document)).toContain("The document needs a title.");
  });

  it("requires the author to be an email, as the XSD's pattern does", () => {
    const document = documentWith();
    document.info.author = "Jane Engineer";
    expect(messages(document)).toContain("The author must be an email address.");

    document.info.author = "jane@example.com";
    expect(messages(document)).not.toContain("The author must be an email address.");
  });

  it("requires an ISO date", () => {
    const document = documentWith();
    document.info.date = "04/09/2026";
    expect(messages(document).some((m) => m.includes("YYYY-MM-DD"))).toBe(true);
  });

  it("warns that a specification with no requirements tests nothing", () => {
    const document = documentWith({ requirements: [] });
    const issue = checkDocument(document).find((i) =>
      i.message.includes("no requirements"),
    );
    expect(issue?.severity).toBe("warning");
  });

  it("warns that empty applicability means every entity in the model", () => {
    const document = documentWith({ applicability: { facets: [] } });
    expect(
      messages(document).some((m) => m.includes("every entity in the model")),
    ).toBe(true);
  });

  it("does not warn about empty applicability when there is nothing to apply", () => {
    // Both warnings at once would be noise; the missing requirements are the
    // real problem.
    const document = documentWith({ applicability: { facets: [] }, requirements: [] });
    expect(
      messages(document).some((m) => m.includes("every entity in the model")),
    ).toBe(false);
  });

  it("treats prohibited applicability as an absence check", () => {
    const document = documentWith({
      applicability: {
        facets: [{ id: "f", facet: { kind: "entity", name: simple("IFCWALL") } }],
        minOccurs: 0,
        maxOccurs: 0,
      },
      requirements: [],
    });
    expect(messages(document)).not.toContain(
      "This specification has no requirements, so it will pass for every model.",
    );
  });

  it("catches minOccurs above maxOccurs", () => {
    const document = documentWith({
      applicability: { facets: [], minOccurs: 5, maxOccurs: 2 },
    });
    expect(messages(document).some((m) => m.includes("greater than"))).toBe(true);
  });

  it("catches an empty facet value, which is schema-valid and useless", () => {
    const document = documentWith({
      applicability: {
        facets: [{ id: "f", facet: { kind: "entity", name: simple("  ") } }],
      },
    });
    expect(messages(document).some((m) => m.includes("empty entity name"))).toBe(true);
  });

  it("catches a restriction that constrains nothing", () => {
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "required",
          facet: {
            kind: "attribute",
            name: { kind: "restriction", base: "xs:string" },
          },
        },
      ],
    });
    expect(messages(document).some((m) => m.includes("no conditions"))).toBe(true);
  });

  it("catches an invalid regex pattern", () => {
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "required",
          facet: {
            kind: "attribute",
            name: { kind: "restriction", base: "xs:string", pattern: "([unclosed" },
          },
        },
      ],
    });
    expect(messages(document).some((m) => m.includes("not valid regex"))).toBe(true);
  });

  it("catches inverted bounds", () => {
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "required",
          facet: {
            kind: "property",
            propertySet: simple("Qto"),
            baseName: simple("Length"),
            value: {
              kind: "restriction",
              base: "xs:double",
              bounds: { minInclusive: 10, maxInclusive: 2 },
            },
          },
        },
      ],
    });
    expect(
      messages(document).some((m) => m.includes("minimum above its maximum")),
    ).toBe(true);
  });

  it("requires an uppercase property data type", () => {
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "required",
          facet: {
            kind: "property",
            propertySet: simple("Pset_WallCommon"),
            baseName: simple("FireRating"),
            dataType: "IfcLabel",
          },
        },
      ],
    });
    expect(messages(document).some((m) => m.includes("uppercase"))).toBe(true);
  });

  it("warns about duplicate specification names, which make a report ambiguous", () => {
    const document = documentWith();
    document.specifications.push({
      ...document.specifications[0],
      id: "spec-2",
    });
    expect(
      checkDocument(document).some(
        (i) => i.severity === "warning" && i.message.includes("same name"),
      ),
    ).toBe(true);
  });

  it("points each issue at the specification it came from", () => {
    const document = documentWith({ requirements: [] });
    const issue = checkDocument(document).find((i) => i.specificationId);
    expect(issue?.specificationId).toBe(document.specifications[0].id);
    expect(issue?.where).toBe("Walls are named");
  });

  it("accepts a bare material facet, which means 'has any material'", () => {
    const document = documentWith({
      requirements: [
        { id: "r", cardinality: "required", facet: { kind: "material" } },
      ],
    });
    expect(checkDocument(document)).toEqual([]);
  });
});

describe("XSD validation", () => {
  it.each([
    ["required", 1, "unbounded"],
    ["optional", 0, "unbounded"],
    ["prohibited", 0, 0],
  ] as const)("accepts %s filter optionality", async (_choice, min, max) => {
    const document = documentWith();
    document.specifications[0].applicability.minOccurs = min;
    document.specifications[0].applicability.maxOccurs = max;

    const result = await validateAgainstSchema(document);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  }, 60_000);

  it("accepts a document this app produced", async () => {
    const result = await validateAgainstSchema(documentWith());

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.xml).toContain("<ids");
  }, 60_000);

  it("accepts every facet and restriction family", async () => {
    const document = documentWith({
      requirements: [
        {
          id: "r1",
          cardinality: "required",
          facet: {
            kind: "property",
            propertySet: simple("Pset_WallCommon"),
            baseName: simple("FireRating"),
            dataType: "IFCLABEL",
            value: {
              kind: "restriction",
              base: "xs:string",
              enumeration: ["REI 60", "REI 90"],
            },
          },
        },
        {
          id: "r2",
          cardinality: "optional",
          facet: {
            kind: "classification",
            system: simple("Uniclass"),
            value: { kind: "restriction", base: "xs:string", pattern: "EF_.*" },
          },
        },
        {
          id: "r3",
          cardinality: "prohibited",
          facet: { kind: "material", value: simple("Asbestos") },
        },
        {
          id: "r4",
          cardinality: "required",
          facet: {
            kind: "partOf",
            relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
            entity: { kind: "entity", name: simple("IFCBUILDINGSTOREY") },
          },
        },
      ],
    });

    const result = await validateAgainstSchema(document);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  }, 60_000);

  it("validates with no network access at all", async () => {
    // The schemas are inlined and their imports point at siblings, so libxml2
    // never reaches for w3.org. A fetch here would break under the CSP and
    // offline.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("Validation attempted a network request");
    }) as typeof fetch;

    try {
      const result = await validateAgainstSchema(documentWith());
      expect(result.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 60_000);

  it("reports schema errors with a line number", async () => {
    // `optional` is not in ids:simpleCardinality, so an entity requirement
    // carrying it is invalid however reasonable it looks.
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "optional",
          facet: { kind: "entity", name: simple("IFCWALL") },
        },
      ],
    });

    const result = await validateAgainstSchema(document);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toBeTruthy();
    expect(result.errors[0].line).toBeGreaterThan(0);
  }, 60_000);
});

describe("authoring issues carry what a translator needs", () => {
  it("names each problem by code, not only by its English sentence", () => {
    const empty = emptyDocument("");
    empty.info.date = "04/09/2026";
    const codes = checkDocument(empty).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["titleMissing", "dateFormat", "noSpecifications"]));
  });

  it("separates the document from a specification, and numbers one with no name", () => {
    const document = documentWith({ name: "" });
    const nameless = checkDocument(document).find((issue) => issue.code === "specNameMissing");
    expect(nameless).toMatchObject({ whereKind: "specification", whereIndex: 1 });

    const named = checkDocument(documentWith({ requirements: [] })).find(
      (issue) => issue.code === "noRequirements",
    );
    expect(named).toMatchObject({ whereKind: "specification", where: "Walls are named" });
    expect(named?.whereIndex).toBeUndefined();

    expect(checkDocument(emptyDocument(""))[0].whereKind).toBe("document");
  });

  it("reports a facet's problem with the facet and field, and where it sits", () => {
    const document = documentWith({
      requirements: [
        {
          id: "r",
          cardinality: "required",
          facet: { kind: "property", propertySet: simple(""), baseName: simple("FireRating") },
        },
      ],
    });
    const issue = checkDocument(document).find((i) => i.code === "facetEmpty");
    expect(issue).toMatchObject({
      scope: "requirement",
      params: { facet: "property", field: "propertySet" },
    });
    // The English sentence is unchanged, for whatever still reads it.
    expect(issue?.message).toBe("Requirement — Property has an empty property set.");
  });

  it("gives the min and max for an occurrence range the wrong way round", () => {
    const document = documentWith();
    document.specifications[0].applicability.minOccurs = 5;
    document.specifications[0].applicability.maxOccurs = 2;
    expect(checkDocument(document).find((i) => i.code === "occursOrder")?.params).toEqual({
      min: 5,
      max: 2,
    });
  });
});
