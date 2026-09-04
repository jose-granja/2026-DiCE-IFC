/**
 * The IDS 1.0 document model.
 *
 * Mirrors `lib/ids/schema/ids.xsd` (the official buildingSMART schema, vendored
 * so validation works offline). Defined here rather than imported from an
 * engine for the same reason `lib/ifc/types.ts` is: the model is the *standard*,
 * not a vendor's rendering of it, and the authoring half of this module has no
 * library behind it at all.
 *
 * Two things the XSD enforces that are easy to get wrong and are therefore
 * encoded in the types rather than left to the serialiser:
 *
 * - **`<info>` children and facets inside `<applicability>` are `xs:sequence`s,
 *   so their order is fixed.** `SEQUENCE` constants below are the order; a
 *   document emitted in any other order is schema-invalid even though every
 *   element is present.
 * - **Cardinality differs by facet.** Entity and PartOf take
 *   `simpleCardinality` (required | prohibited); the other four take
 *   `conditionalCardinality`, which adds `optional`. Offering `optional` on an
 *   entity requirement would produce a file no validator accepts.
 */

/** The schemas a specification may declare. */
export const IFC_VERSIONS = ["IFC2X3", "IFC4", "IFC4X3_ADD2"] as const;
export type IdsIfcVersion = (typeof IFC_VERSIONS)[number];

export const IDS_NAMESPACE = "http://standards.buildingsmart.org/IDS";
export const IDS_SCHEMA_LOCATION =
  "http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd";

// ---------------------------------------------------------------------------
// Values and restrictions
// ---------------------------------------------------------------------------

/**
 * `ids:idsValue` — a choice of a literal or an `xs:restriction`.
 *
 * The XSD models these as alternatives, so this is a discriminated union rather
 * than an object with optional fields: a value cannot be both.
 */
export type IdsValue = SimpleValue | RestrictionValue;

export type SimpleValue = { kind: "simple"; value: string };

/**
 * `xs:restriction`. The XSD allows any facet; these are the four families the
 * editor offers, which is what IDS documents in the wild actually use.
 *
 * Facets within one restriction are **conjunctive** — a value must satisfy all
 * of them.
 */
export type RestrictionValue = {
  kind: "restriction";
  /** `xs:string`, `xs:integer`, `xs:double`, `xs:date`, `xs:boolean`. */
  base: RestrictionBase;
  /** `xs:enumeration` — one of these values. */
  enumeration?: string[];
  /** `xs:pattern` — an XSD regular expression. */
  pattern?: string;
  bounds?: {
    minInclusive?: number;
    maxInclusive?: number;
    minExclusive?: number;
    maxExclusive?: number;
  };
  length?: {
    length?: number;
    minLength?: number;
    maxLength?: number;
  };
};

export const RESTRICTION_BASES = [
  "xs:string",
  "xs:integer",
  "xs:double",
  "xs:date",
  "xs:boolean",
] as const;
export type RestrictionBase = (typeof RESTRICTION_BASES)[number];

export function simple(value: string): SimpleValue {
  return { kind: "simple", value };
}

/** Does this restriction actually constrain anything? */
export function isEmptyRestriction(value: RestrictionValue): boolean {
  return (
    (value.enumeration?.length ?? 0) === 0 &&
    !value.pattern &&
    !hasAny(value.bounds) &&
    !hasAny(value.length)
  );
}

function hasAny(record: Record<string, number | undefined> | undefined): boolean {
  return Boolean(
    record && Object.values(record).some((v) => v !== undefined && v !== null),
  );
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

export type FacetKind =
  | "entity"
  | "partOf"
  | "classification"
  | "attribute"
  | "property"
  | "material";

/**
 * Facet order inside `<applicability>` and `<requirements>`.
 *
 * This is an `xs:sequence`: emitting a `<property>` before a `<classification>`
 * is invalid however correct each element is on its own.
 */
export const FACET_SEQUENCE: FacetKind[] = [
  "entity",
  "partOf",
  "classification",
  "attribute",
  "property",
  "material",
];

/** `ids:relations` — serialised uppercase, per the XSD enumeration. */
export const PART_OF_RELATIONS = [
  "IFCRELAGGREGATES",
  "IFCRELASSIGNSTOGROUP",
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  "IFCRELNESTS",
  "IFCRELVOIDSELEMENT IFCRELFILLSELEMENT",
] as const;
export type PartOfRelation = (typeof PART_OF_RELATIONS)[number];

export type EntityFacet = {
  kind: "entity";
  name: IdsValue;
  predefinedType?: IdsValue;
};

export type PartOfFacet = {
  kind: "partOf";
  /** The parent this entity must be part of. Required by the XSD. */
  entity: EntityFacet;
  relation?: PartOfRelation;
};

export type ClassificationFacet = {
  kind: "classification";
  /** Required by the XSD, unlike `value`. */
  system: IdsValue;
  value?: IdsValue;
  uri?: string;
};

export type AttributeFacet = {
  kind: "attribute";
  name: IdsValue;
  value?: IdsValue;
};

export type PropertyFacet = {
  kind: "property";
  propertySet: IdsValue;
  /**
   * The property name **as stored in the IFC file** — the XSD calls it
   * `baseName` precisely because it is not the localised presentation name.
   */
  baseName: IdsValue;
  value?: IdsValue;
  /** An IFC defined type, all uppercase, e.g. `IFCLABEL`. */
  dataType?: string;
  uri?: string;
};

export type MaterialFacet = {
  kind: "material";
  value?: IdsValue;
  uri?: string;
};

export type Facet =
  | EntityFacet
  | PartOfFacet
  | ClassificationFacet
  | AttributeFacet
  | PropertyFacet
  | MaterialFacet;

// ---------------------------------------------------------------------------
// Cardinality
// ---------------------------------------------------------------------------

export const SIMPLE_CARDINALITIES = ["required", "prohibited"] as const;
export const CONDITIONAL_CARDINALITIES = [
  "required",
  "optional",
  "prohibited",
] as const;

export type Cardinality = (typeof CONDITIONAL_CARDINALITIES)[number];

/**
 * Which cardinality values a facet may carry.
 *
 * Entity and PartOf use `ids:simpleCardinality`, which has no `optional`. This
 * is not a quirk to smooth over: "this entity is optionally a wall" has no
 * meaning, and the XSD says so.
 */
export function allowedCardinalities(kind: FacetKind): readonly Cardinality[] {
  return kind === "entity" || kind === "partOf"
    ? SIMPLE_CARDINALITIES
    : CONDITIONAL_CARDINALITIES;
}

// ---------------------------------------------------------------------------
// Specifications
// ---------------------------------------------------------------------------

/** A facet inside `<requirements>`, which additionally carries cardinality. */
export type Requirement = {
  /** Stable local id, for React keys and drag-and-drop. Not serialised. */
  id: string;
  facet: Facet;
  cardinality: Cardinality;
  instructions?: string;
};

export type Applicability = {
  facets: Array<{ id: string; facet: Facet }>;
  /** `xs:occurs` on `<applicability>` — how many entities must match. */
  minOccurs?: number;
  maxOccurs?: number | "unbounded";
};

/** IDS 1.0's three supported ways to count entities matching the filters. */
export function applicabilityCardinality(block: Applicability): Cardinality | null {
  if (block.minOccurs === 1 && block.maxOccurs === "unbounded") return "required";
  if (block.minOccurs === 0 && block.maxOccurs === "unbounded") return "optional";
  if (block.minOccurs === 0 && block.maxOccurs === 0) return "prohibited";
  return null;
}

export type Specification = {
  /** Stable local id. Not serialised; `identifier` is the IDS-level one. */
  id: string;
  name: string;
  ifcVersions: IdsIfcVersion[];
  /** Editor default for new requirements. Not serialised to IDS XML. */
  defaultRequirementCardinality?: Cardinality;
  identifier?: string;
  description?: string;
  instructions?: string;
  applicability: Applicability;
  requirements: Requirement[];
};

/** `<info>` children, in the order the XSD's sequence requires. */
export const INFO_SEQUENCE = [
  "title",
  "copyright",
  "version",
  "description",
  "author",
  "date",
  "purpose",
  "milestone",
] as const;

export type IdsInfo = {
  /** The only required child. */
  title: string;
  copyright?: string;
  version?: string;
  description?: string;
  /** Must be an email address; the XSD constrains it with a pattern. */
  author?: string;
  /** `xs:date`, i.e. `YYYY-MM-DD`. */
  date?: string;
  purpose?: string;
  milestone?: string;
};

export type IdsDocument = {
  info: IdsInfo;
  specifications: Specification[];
};

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

let sequence = 0;
export const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

export function emptyDocument(title = "Untitled specification"): IdsDocument {
  return {
    info: { title, date: new Date().toISOString().slice(0, 10) },
    specifications: [],
  };
}

export function emptySpecification(name = "New specification"): Specification {
  return {
    id: nextId("spec"),
    name,
    // IFC4 alone by default: claiming a specification applies to schemas it was
    // never checked against is worse than making the author opt in.
    ifcVersions: ["IFC4"],
    applicability: { facets: [], minOccurs: 1, maxOccurs: "unbounded" },
    requirements: [],
  };
}

/** A facet of the given kind, with the fields the XSD requires already present. */
export function emptyFacet(kind: FacetKind): Facet {
  switch (kind) {
    case "entity":
      return { kind: "entity", name: simple("") };
    case "partOf":
      return { kind: "partOf", entity: { kind: "entity", name: simple("") } };
    case "classification":
      return { kind: "classification", system: simple("") };
    case "attribute":
      return { kind: "attribute", name: simple("") };
    case "property":
      return { kind: "property", propertySet: simple(""), baseName: simple("") };
    case "material":
      return { kind: "material" };
  }
}

export const FACET_LABELS: Record<FacetKind, string> = {
  entity: "Entity",
  partOf: "Part of",
  classification: "Classification",
  attribute: "Attribute",
  property: "Property",
  material: "Material",
};

export const FACET_HINTS: Record<FacetKind, string> = {
  entity: "The IFC class, and optionally its predefined type.",
  partOf: "The element must belong to a parent through an IFC relationship.",
  classification: "A classification reference — system, and optionally a code.",
  attribute: "A named IFC attribute, and optionally its value.",
  property: "A property in a property set, and optionally its value and data type.",
  material: "The material assigned to the element.",
};
