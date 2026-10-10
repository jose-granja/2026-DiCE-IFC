/**
 * IDS 1.0 XML reader.
 *
 * Pairs with `serialize.ts` so a document can be imported, edited and written
 * back. Uses `DOMParser`, which exists in the browser and in the jsdom
 * environment the tests run under — the alternative, a hand-rolled tokeniser,
 * would be a second XML implementation to keep correct for no gain.
 *
 * **Tolerant on the way in, strict on the way out.** Files in the wild carry
 * `cardinality="Required"`, unrecognised `relation` values and missing optional
 * elements. Rejecting them would make the editor useless as a repair tool,
 * which is one of the things it is for. So parsing normalises what it can and
 * *reports* what it changed, and serialisation then emits a schema-valid file.
 */

import {
  IFC_VERSIONS,
  PART_OF_RELATIONS,
  RESTRICTION_BASES,
  allowedCardinalities,
  nextId,
  simple,
  type Applicability,
  type AttributeFacet,
  type Cardinality,
  type ClassificationFacet,
  type EntityFacet,
  type Facet,
  type IdsDocument,
  type IdsIfcVersion,
  type IdsInfo,
  type IdsValue,
  type MaterialFacet,
  type PartOfFacet,
  type PartOfRelation,
  type PropertyFacet,
  type Requirement,
  type RestrictionBase,
  type RestrictionValue,
  type Specification,
} from "./types";

export class IdsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdsParseError";
  }
}

/** Something the file said that had to be changed to be representable. */
export type ParseNote = {
  path: string;
  message: string;
};

export type ParseResult = {
  document: IdsDocument;
  notes: ParseNote[];
};

export function parseIds(xml: string): ParseResult {
  const parser = new DOMParser();
  const dom = parser.parseFromString(xml, "application/xml");

  // DOMParser reports failure as a `<parsererror>` element rather than by
  // throwing, so a malformed file otherwise parses to a document with no <ids>.
  const failure = dom.querySelector("parsererror");
  if (failure) {
    throw new IdsParseError(
      `That file is not well-formed XML: ${failure.textContent?.trim().split("\n")[0] ?? "unknown error"}`,
    );
  }

  const root = dom.documentElement;
  if (!root || localName(root) !== "ids") {
    throw new IdsParseError(
      `Expected an <ids> root element, found <${root ? localName(root) : "nothing"}>.`,
    );
  }

  const notes: ParseNote[] = [];
  const infoElement = child(root, "info");

  return {
    document: {
      info: parseInfo(infoElement, notes),
      specifications: children(child(root, "specifications"), "specification").map(
        (element, index) => parseSpecification(element, index, notes),
      ),
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// <info>
// ---------------------------------------------------------------------------

function parseInfo(element: Element | null, notes: ParseNote[]): IdsInfo {
  const title = text(child(element, "title"));
  if (!title) {
    notes.push({
      path: "info/title",
      message: "The document had no title; using a placeholder.",
    });
  }

  return {
    title: title || "Untitled specification",
    copyright: text(child(element, "copyright")) || undefined,
    version: text(child(element, "version")) || undefined,
    description: text(child(element, "description")) || undefined,
    author: text(child(element, "author")) || undefined,
    date: text(child(element, "date")) || undefined,
    purpose: text(child(element, "purpose")) || undefined,
    milestone: text(child(element, "milestone")) || undefined,
  };
}

// ---------------------------------------------------------------------------
// <specification>
// ---------------------------------------------------------------------------

function parseSpecification(
  element: Element,
  index: number,
  notes: ParseNote[],
): Specification {
  const path = `specification[${index + 1}]`;
  const name = element.getAttribute("name") ?? "";

  const rawVersions = (element.getAttribute("ifcVersion") ?? "").trim();
  const versions: IdsIfcVersion[] = [];
  for (const token of rawVersions.split(/\s+/).filter(Boolean)) {
    if ((IFC_VERSIONS as readonly string[]).includes(token)) {
      versions.push(token as IdsIfcVersion);
    } else {
      notes.push({
        path: `${path}/@ifcVersion`,
        message: `Dropped unrecognised schema "${token}".`,
      });
    }
  }
  if (versions.length === 0) {
    notes.push({
      path: `${path}/@ifcVersion`,
      message: "No usable IFC schema declared; defaulting to IFC4.",
    });
    versions.push("IFC4");
  }

  const applicabilityElement = child(element, "applicability");

  return {
    id: nextId("spec"),
    name: name || `Specification ${index + 1}`,
    ifcVersions: versions,
    identifier: element.getAttribute("identifier") ?? undefined,
    description: element.getAttribute("description") ?? undefined,
    instructions: element.getAttribute("instructions") ?? undefined,
    applicability: parseApplicability(applicabilityElement, path, notes),
    requirements: parseRequirements(child(element, "requirements"), path, notes),
  };
}

function parseApplicability(
  element: Element | null,
  path: string,
  notes: ParseNote[],
): Applicability {
  const facets = elementChildren(element)
    .map((child) => parseFacet(child, `${path}/applicability`, notes))
    .filter((facet): facet is Facet => facet !== null)
    .map((facet) => ({ id: nextId("facet"), facet }));

  const min = element?.getAttribute("minOccurs");
  const max = element?.getAttribute("maxOccurs");

  if (element?.getAttribute("cardinality")) {
    // IDS 1.0 has no cardinality on <applicability>; it is meaningless there.
    notes.push({
      path: `${path}/applicability/@cardinality`,
      message: "Removed a cardinality attribute, which IDS 1.0 does not allow here.",
    });
  }

  return {
    facets,
    minOccurs: min === null ? undefined : Number(min),
    maxOccurs:
      max === null ? undefined : max === "unbounded" ? "unbounded" : Number(max),
  };
}

function parseRequirements(
  element: Element | null,
  path: string,
  notes: ParseNote[],
): Requirement[] {
  const out: Requirement[] = [];

  for (const element_ of elementChildren(element)) {
    const facet = parseFacet(element_, `${path}/requirements`, notes);
    if (!facet) continue;

    out.push({
      id: nextId("req"),
      facet,
      cardinality: normaliseCardinality(
        element_.getAttribute("cardinality"),
        facet,
        `${path}/requirements`,
        notes,
      ),
      instructions: element_.getAttribute("instructions") ?? undefined,
    });
  }

  return out;
}

function normaliseCardinality(
  raw: string | null,
  facet: Facet,
  path: string,
  notes: ParseNote[],
): Cardinality {
  const allowed = allowedCardinalities(facet.kind);

  if (raw === null) return "required";

  const lower = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(lower)) return lower as Cardinality;

  // `optional` on an entity or partOf facet is the common case here: the XSD
  // does not allow it, and silently keeping it would emit an invalid file.
  notes.push({
    path: `${path}/${facet.kind}/@cardinality`,
    message: `"${raw}" is not a cardinality this facet allows; using "required".`,
  });
  return "required";
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

function parseFacet(
  element: Element,
  path: string,
  notes: ParseNote[],
): Facet | null {
  switch (localName(element)) {
    case "entity":
      return parseEntity(element);

    case "partOf": {
      const entityElement = child(element, "entity");
      if (!entityElement) {
        notes.push({
          path: `${path}/partOf`,
          message: "Dropped a partOf facet with no entity, which IDS 1.0 requires.",
        });
        return null;
      }

      const rawRelation = element.getAttribute("relation");
      let relation: PartOfRelation | undefined;
      if (rawRelation) {
        const upper = rawRelation.trim().toUpperCase();
        if ((PART_OF_RELATIONS as readonly string[]).includes(upper)) {
          relation = upper as PartOfRelation;
        } else {
          notes.push({
            path: `${path}/partOf/@relation`,
            message: `Dropped unrecognised relation "${rawRelation}".`,
          });
        }
      }

      return {
        kind: "partOf",
        entity: parseEntity(entityElement),
        relation,
      } satisfies PartOfFacet;
    }

    case "classification": {
      const system = parseValue(child(element, "system"));
      if (!system) {
        notes.push({
          path: `${path}/classification`,
          message: "Dropped a classification facet with no system, which IDS 1.0 requires.",
        });
        return null;
      }
      return {
        kind: "classification",
        system,
        value: parseValue(child(element, "value")) ?? undefined,
        uri: element.getAttribute("uri") ?? undefined,
      } satisfies ClassificationFacet;
    }

    case "attribute": {
      const name = parseValue(child(element, "name"));
      if (!name) {
        notes.push({
          path: `${path}/attribute`,
          message: "Dropped an attribute facet with no name.",
        });
        return null;
      }
      return {
        kind: "attribute",
        name,
        value: parseValue(child(element, "value")) ?? undefined,
      } satisfies AttributeFacet;
    }

    case "property": {
      const propertySet = parseValue(child(element, "propertySet"));
      const baseName = parseValue(child(element, "baseName"));
      if (!propertySet || !baseName) {
        notes.push({
          path: `${path}/property`,
          message: "Dropped a property facet missing its property set or name.",
        });
        return null;
      }
      return {
        kind: "property",
        propertySet,
        baseName,
        value: parseValue(child(element, "value")) ?? undefined,
        dataType: element.getAttribute("dataType") ?? undefined,
        uri: element.getAttribute("uri") ?? undefined,
      } satisfies PropertyFacet;
    }

    case "material":
      return {
        kind: "material",
        value: parseValue(child(element, "value")) ?? undefined,
        uri: element.getAttribute("uri") ?? undefined,
      } satisfies MaterialFacet;

    default:
      notes.push({
        path,
        message: `Ignored unknown element <${localName(element)}>.`,
      });
      return null;
  }
}

function parseEntity(element: Element): EntityFacet {
  return {
    kind: "entity",
    name: parseValue(child(element, "name")) ?? simple(""),
    predefinedType: parseValue(child(element, "predefinedType")) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// ids:idsValue
// ---------------------------------------------------------------------------

function parseValue(element: Element | null): IdsValue | null {
  if (!element) return null;

  const simpleElement = child(element, "simpleValue");
  if (simpleElement) return simple(text(simpleElement));

  const restriction = child(element, "restriction");
  if (!restriction) return null;

  const rawBase = restriction.getAttribute("base") ?? "xs:string";
  const base = ((RESTRICTION_BASES as readonly string[]).includes(rawBase)
    ? rawBase
    : "xs:string") as RestrictionBase;

  const value: RestrictionValue = { kind: "restriction", base };

  const enumeration = children(restriction, "enumeration")
    .map((item) => item.getAttribute("value") ?? "")
    .filter((item) => item !== "");
  if (enumeration.length > 0) value.enumeration = enumeration;

  const pattern = child(restriction, "pattern")?.getAttribute("value");
  if (pattern) value.pattern = pattern;

  const bounds: NonNullable<RestrictionValue["bounds"]> = {};
  for (const facet of ["minInclusive", "maxInclusive", "minExclusive", "maxExclusive"] as const) {
    const raw = child(restriction, facet)?.getAttribute("value");
    if (raw !== null && raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) bounds[facet] = parsed;
    }
  }
  if (Object.keys(bounds).length > 0) value.bounds = bounds;

  const length: NonNullable<RestrictionValue["length"]> = {};
  for (const facet of ["length", "minLength", "maxLength"] as const) {
    const raw = child(restriction, facet)?.getAttribute("value");
    if (raw !== null && raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) length[facet] = parsed;
    }
  }
  if (Object.keys(length).length > 0) value.length = length;

  return value;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Local name, ignoring the prefix.
 *
 * IDS files use `<xs:restriction>` but the prefix is only a convention — a file
 * may bind the XML Schema namespace to any prefix, or to the default one.
 * Matching on the raw `tagName` would work on most files and fail on some, in a
 * way that looks like the file being wrong.
 */
function localName(element: Element): string {
  return element.localName || element.tagName.replace(/^.*:/, "");
}

function elementChildren(parent: Element | null): Element[] {
  if (!parent) return [];
  return Array.from(parent.children);
}

function child(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  return elementChildren(parent).find((el) => localName(el) === name) ?? null;
}

function children(parent: Element | null, name: string): Element[] {
  return elementChildren(parent).filter((el) => localName(el) === name);
}

function text(element: Element | null): string {
  return element?.textContent?.trim() ?? "";
}
