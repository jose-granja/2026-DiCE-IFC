// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { IdsParseError, parseIds } from "../parse";
import { idsFileName, serializeIds } from "../serialize";
import {
  emptyDocument,
  emptySpecification,
  simple,
  type IdsDocument,
  type RestrictionValue,
} from "../types";

/** A document exercising every facet, both blocks, and every restriction family. */
function richDocument(): IdsDocument {
  return {
    info: {
      title: "Structural handover",
      copyright: "© 2026 DiCE",
      version: "1.2.0",
      description: "What structural models must carry at handover.",
      author: "engineer@example.com",
      date: "2026-09-04",
      purpose: "Handover",
      milestone: "Construction",
    },
    specifications: [
      {
        id: "s1",
        name: "Load-bearing walls carry a fire rating",
        ifcVersions: ["IFC4", "IFC4X3_ADD2"],
        identifier: "SPEC-001",
        description: "Every load-bearing wall must declare its fire rating.",
        instructions: "Set FireRating in Pset_WallCommon.",
        applicability: {
          minOccurs: 1,
          maxOccurs: "unbounded",
          facets: [
            {
              id: "f1",
              facet: {
                kind: "entity",
                name: simple("IFCWALL"),
                predefinedType: simple("SOLIDWALL"),
              },
            },
            {
              id: "f2",
              facet: {
                kind: "property",
                propertySet: simple("Pset_WallCommon"),
                baseName: simple("LoadBearing"),
                value: simple("TRUE"),
                dataType: "IFCBOOLEAN",
              },
            },
          ],
        },
        requirements: [
          {
            id: "r1",
            cardinality: "required",
            instructions: "REI 30, 60, 90 or 120.",
            facet: {
              kind: "property",
              propertySet: simple("Pset_WallCommon"),
              baseName: simple("FireRating"),
              dataType: "IFCLABEL",
              value: {
                kind: "restriction",
                base: "xs:string",
                enumeration: ["REI 30", "REI 60", "REI 90", "REI 120"],
              },
            },
          },
          {
            id: "r2",
            cardinality: "optional",
            facet: {
              kind: "classification",
              system: simple("Uniclass"),
              value: {
                kind: "restriction",
                base: "xs:string",
                pattern: "EF_25_10(_\\d+)?",
              },
              uri: "https://uniclass.thenbs.com/",
            },
          },
          {
            id: "r3",
            cardinality: "prohibited",
            facet: {
              kind: "material",
              value: simple("Asbestos"),
              uri: "https://identifier.buildingsmart.org/uri/bs/ifc/4.3/mat/Asbestos",
            },
          },
          {
            id: "r4",
            cardinality: "required",
            facet: {
              kind: "attribute",
              name: simple("Name"),
              value: {
                kind: "restriction",
                base: "xs:string",
                length: { minLength: 3, maxLength: 64 },
              },
            },
          },
          {
            id: "r5",
            cardinality: "required",
            facet: {
              kind: "partOf",
              relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
              entity: { kind: "entity", name: simple("IFCBUILDINGSTOREY") },
            },
          },
        ],
      },
      {
        id: "s2",
        name: "Beams are within span limits",
        ifcVersions: ["IFC4"],
        applicability: { facets: [] },
        requirements: [
          {
            id: "r6",
            cardinality: "required",
            facet: {
              kind: "property",
              propertySet: simple("Qto_BeamBaseQuantities"),
              baseName: simple("Length"),
              dataType: "IFCLENGTHMEASURE",
              // The bSDD URI the editor can fill in from a dictionary; it has
              // to survive a write/read cycle or filling it is pointless.
              uri: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcBeam/prop/Qto_BeamBaseQuantities/Length",
              value: {
                kind: "restriction",
                base: "xs:double",
                bounds: { minInclusive: 0.5, maxExclusive: 12 },
              },
            },
          },
        ],
      },
    ],
  };
}

describe("facet URIs", () => {
  it("writes and reads back the uri on every facet that has one", () => {
    // IDS lets a classification, property or material facet point at the
    // external definition it means. That pointer is what makes a specification
    // resolvable by a tool that has never seen the author's naming, so losing
    // it in the round trip would quietly strip the interoperability.
    const { document } = parseIds(serializeIds(richDocument()));
    const facets = document.specifications.flatMap((specification) => [
      ...specification.applicability.facets.map((entry) => entry.facet),
      ...specification.requirements.map((entry) => entry.facet),
    ]);

    const uris = facets
      .map((facet) => ("uri" in facet ? facet.uri : undefined))
      .filter(Boolean);

    expect(uris).toContain("https://uniclass.thenbs.com/");
    expect(uris).toContain(
      "https://identifier.buildingsmart.org/uri/bs/ifc/4.3/mat/Asbestos",
    );
    expect(uris).toContain(
      "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcBeam/prop/Qto_BeamBaseQuantities/Length",
    );
  });

  it("omits the attribute entirely when the author added the field but left it blank", () => {
    // The editor's "+ URI" button creates an empty string. Writing uri="" would
    // be a URI that resolves to the document itself, which is a lie.
    const document_ = richDocument();
    const facet = document_.specifications[1].requirements[0].facet;
    if (facet.kind === "property") facet.uri = "";

    expect(serializeIds(document_)).not.toContain('uri=""');
  });
});

describe("serialisation", () => {
  it("emits a schema-shaped document", () => {
    const xml = serializeIds(richDocument());

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://standards.buildingsmart.org/IDS"');
    expect(xml).toContain('xmlns:xs="http://www.w3.org/2001/XMLSchema"');
    expect(xml).toContain("</ids>");
  });

  it("writes <info> children in the schema's sequence order", () => {
    const xml = serializeIds(richDocument());
    const order = ["title", "copyright", "version", "description", "author", "date", "purpose", "milestone"];

    const positions = order.map((tag) => xml.indexOf(`<${tag}>`));
    // Every one present, and strictly increasing — this is an xs:sequence, so
    // a document with the right elements in the wrong order is invalid.
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("writes facets in the schema's sequence order regardless of authoring order", () => {
    const document = emptyDocument();
    const spec = emptySpecification();
    // Deliberately authored backwards.
    spec.requirements = [
      { id: "a", cardinality: "required", facet: { kind: "material", value: simple("Steel") } },
      { id: "b", cardinality: "required", facet: { kind: "attribute", name: simple("Name") } },
      { id: "c", cardinality: "required", facet: { kind: "entity", name: simple("IFCBEAM") } },
    ];
    document.specifications = [spec];

    const xml = serializeIds(document);
    expect(xml.indexOf("<entity")).toBeLessThan(xml.indexOf("<attribute"));
    expect(xml.indexOf("<attribute")).toBeLessThan(xml.indexOf("<material"));
  });

  it("writes ifcVersion as a space-separated list, not repeated attributes", () => {
    const xml = serializeIds(richDocument());
    expect(xml).toContain('ifcVersion="IFC4 IFC4X3_ADD2"');
  });

  it("writes <value> before <system> on a classification, as the sequence requires", () => {
    const xml = serializeIds(richDocument());
    const block = xml.slice(xml.indexOf("<classification"), xml.indexOf("</classification>"));
    expect(block.indexOf("<value>")).toBeLessThan(block.indexOf("<system>"));
  });

  it("emits every restriction family", () => {
    const xml = serializeIds(richDocument());
    expect(xml).toContain('<xs:enumeration value="REI 60"/>');
    expect(xml).toContain("<xs:pattern");
    expect(xml).toContain('<xs:minInclusive value="0.5"/>');
    expect(xml).toContain('<xs:maxExclusive value="12"/>');
    expect(xml).toContain('<xs:minLength value="3"/>');
    expect(xml).toContain('<xs:maxLength value="64"/>');
  });

  it("omits absent optional elements rather than emitting them empty", () => {
    const document = emptyDocument("Minimal");
    const xml = serializeIds(document);
    expect(xml).toContain("<title>Minimal</title>");
    expect(xml).not.toContain("<copyright>");
    expect(xml).not.toContain("<purpose>");
  });

  it("self-closes an empty filter list with required occurrence limits", () => {
    const document = emptyDocument();
    document.specifications = [emptySpecification()];
    expect(serializeIds(document)).toContain(
      '<applicability minOccurs="1" maxOccurs="unbounded"/>',
    );
  });

  it("escapes text and attributes", () => {
    const document = emptyDocument('Fire & "safety" <handover>');
    const spec = emptySpecification('Walls & "columns"');
    document.specifications = [spec];

    const xml = serializeIds(document);
    expect(xml).toContain("Fire &amp; &quot;safety&quot; &lt;handover&gt;".replace(/&quot;/g, '"'));
    expect(xml).toContain('name="Walls &amp; &quot;columns&quot;"');
    // Escaped, so the document stays well-formed.
    expect(() => parseIds(xml)).not.toThrow();
  });

  it("is byte-stable, so a saved draft and a re-export compare equal", () => {
    const document = richDocument();
    expect(serializeIds(document)).toBe(serializeIds(document));
  });

  it("names the file from the title", () => {
    expect(idsFileName(emptyDocument("Structural Handover — v2"))).toBe(
      "structural-handover-v2.ids",
    );
    expect(idsFileName(emptyDocument("   "))).toBe("specification.ids");
  });
});

describe("round trip", () => {
  it("survives serialise → parse → serialise unchanged", () => {
    const first = serializeIds(richDocument());
    const { document } = parseIds(first);
    const second = serializeIds(document);

    // The strongest statement available without an XSD: the writer and the
    // reader agree exactly on every construct in the rich document.
    expect(second).toBe(first);
  });

  it("preserves every field through a round trip", () => {
    const { document } = parseIds(serializeIds(richDocument()));

    expect(document.info.title).toBe("Structural handover");
    expect(document.info.author).toBe("engineer@example.com");
    expect(document.info.date).toBe("2026-09-04");
    expect(document.specifications).toHaveLength(2);

    const [spec] = document.specifications;
    expect(spec.name).toBe("Load-bearing walls carry a fire rating");
    expect(spec.ifcVersions).toEqual(["IFC4", "IFC4X3_ADD2"]);
    expect(spec.identifier).toBe("SPEC-001");
    expect(spec.applicability.minOccurs).toBe(1);
    expect(spec.applicability.maxOccurs).toBe("unbounded");
    expect(spec.applicability.facets).toHaveLength(2);
    expect(spec.requirements).toHaveLength(5);
  });

  it("preserves restriction families and their values", () => {
    const { document } = parseIds(serializeIds(richDocument()));
    const requirements = document.specifications[0].requirements;

    const fireRating = requirements.find(
      (r) => r.facet.kind === "property" && r.facet.baseName.kind === "simple" &&
        r.facet.baseName.value === "FireRating",
    )!;
    const value = (fireRating.facet as { value: RestrictionValue }).value;
    expect(value.kind).toBe("restriction");
    expect(value.enumeration).toEqual(["REI 30", "REI 60", "REI 90", "REI 120"]);

    const span = document.specifications[1].requirements[0];
    const bounds = (span.facet as { value: RestrictionValue }).value.bounds;
    expect(bounds).toEqual({ minInclusive: 0.5, maxExclusive: 12 });
  });

  it("preserves cardinality per requirement", () => {
    const { document } = parseIds(serializeIds(richDocument()));
    const cardinalities = document.specifications[0].requirements.map(
      (r) => r.cardinality,
    );
    expect(cardinalities).toContain("required");
    expect(cardinalities).toContain("optional");
    expect(cardinalities).toContain("prohibited");
  });
});

describe("parsing files from the wild", () => {
  const wrap = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Imported</title></info>
  <specifications>${body}</specifications>
</ids>`;

  it("rejects XML that is not well-formed, with a readable message", () => {
    expect(() => parseIds("<ids><info>")).toThrow(IdsParseError);
  });

  it("rejects a document whose root is not <ids>", () => {
    expect(() => parseIds("<notIds/>")).toThrow(/Expected an <ids> root/);
  });

  it("normalises a mis-cased cardinality and says so", () => {
    const { document, notes } = parseIds(
      wrap(`<specification name="S" ifcVersion="IFC4">
        <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
        <requirements><attribute cardinality="Required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
      </specification>`),
    );

    expect(document.specifications[0].requirements[0].cardinality).toBe("required");
    expect(notes).toHaveLength(0);
  });

  it("rejects `optional` on an entity requirement, which the XSD forbids", () => {
    // simpleCardinality has no `optional`. Keeping it would emit a file no
    // validator accepts, from an editor whose job is to produce valid files.
    const { document, notes } = parseIds(
      wrap(`<specification name="S" ifcVersion="IFC4">
        <applicability/>
        <requirements><entity cardinality="optional"><name><simpleValue>IFCWALL</simpleValue></name></entity></requirements>
      </specification>`),
    );

    expect(document.specifications[0].requirements[0].cardinality).toBe("required");
    expect(notes.some((n) => n.message.includes("optional"))).toBe(true);
  });

  it("drops an unrecognised IFC schema token and reports it", () => {
    const { document, notes } = parseIds(
      wrap(`<specification name="S" ifcVersion="IFC4 IFC5"><applicability/><requirements/></specification>`),
    );
    expect(document.specifications[0].ifcVersions).toEqual(["IFC4"]);
    expect(notes.some((n) => n.message.includes("IFC5"))).toBe(true);
  });

  it("defaults to IFC4 when no usable schema is declared", () => {
    const { document, notes } = parseIds(
      wrap(`<specification name="S" ifcVersion=""><applicability/><requirements/></specification>`),
    );
    expect(document.specifications[0].ifcVersions).toEqual(["IFC4"]);
    expect(notes.some((n) => n.path.includes("ifcVersion"))).toBe(true);
  });

  it("drops a classification with no system, which IDS 1.0 requires", () => {
    const { document, notes } = parseIds(
      wrap(`<specification name="S" ifcVersion="IFC4"><applicability/>
        <requirements><classification><value><simpleValue>EF_25</simpleValue></value></classification></requirements>
      </specification>`),
    );
    expect(document.specifications[0].requirements).toHaveLength(0);
    expect(notes.some((n) => n.message.includes("system"))).toBe(true);
  });

  it("flags a cardinality on <applicability>, which IDS 1.0 does not allow", () => {
    const { notes } = parseIds(
      wrap(`<specification name="S" ifcVersion="IFC4">
        <applicability cardinality="required"/><requirements/>
      </specification>`),
    );
    expect(notes.some((n) => n.path.includes("applicability/@cardinality"))).toBe(true);
  });

  it("reads xs:restriction under any prefix binding", () => {
    // The prefix is a convention, not part of the format; a file may bind the
    // XML Schema namespace to anything.
    const xml = `<?xml version="1.0"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:schema="http://www.w3.org/2001/XMLSchema">
  <info><title>Prefixed</title></info>
  <specifications>
    <specification name="S" ifcVersion="IFC4">
      <applicability/>
      <requirements>
        <attribute><name>
          <schema:restriction base="xs:string"><schema:enumeration value="A"/></schema:restriction>
        </name></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

    const { document } = parseIds(xml);
    const name = (document.specifications[0].requirements[0].facet as {
      name: RestrictionValue;
    }).name;
    expect(name.kind).toBe("restriction");
    expect(name.enumeration).toEqual(["A"]);
  });

  it("supplies a title when the file has none", () => {
    const { document, notes } = parseIds(
      `<ids xmlns="http://standards.buildingsmart.org/IDS"><info/><specifications/></ids>`,
    );
    expect(document.info.title).toBeTruthy();
    expect(notes.some((n) => n.path === "info/title")).toBe(true);
  });
});
