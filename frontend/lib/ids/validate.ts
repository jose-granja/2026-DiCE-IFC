/**
 * Validating an authored IDS.
 *
 * Two layers, and they answer different questions:
 *
 * 1. **Authoring checks** ({@link checkDocument}) — "is this specification
 *    going to do what you meant?" A facet with an empty name is schema-valid
 *    and useless; a specification with no requirements passes every validator
 *    and tests nothing. These are the mistakes an author actually makes, and
 *    they run continuously as the document is edited.
 *
 * 2. **XSD validation** ({@link validateAgainstSchema}) — "will any other tool
 *    accept this file?" libxml2 compiled to WebAssembly, against the vendored
 *    buildingSMART schema. Runs on demand, before download, because loading a
 *    WASM libxml2 on every keystroke would be absurd.
 *
 * Both run entirely in the browser. The schemas are inlined (see
 * `schema/generated.ts`), so validation needs no network and reveals nothing.
 */

import { validateXml } from "@/lib/workers/xmllint-client";
import { serializeIds } from "./serialize";
import {
  FACET_LABELS,
  applicabilityCardinality,
  isEmptyRestriction,
  type Facet,
  type IdsDocument,
  type IdsValue,
} from "./types";

// ---------------------------------------------------------------------------
// Authoring checks
// ---------------------------------------------------------------------------

export type IdsIssueSeverity = "error" | "warning";

export type IdsIssue = {
  severity: IdsIssueSeverity;
  /** Where it is, in the user's terms. */
  where: string;
  message: string;
  /** Local id of the specification, so the UI can jump to it. */
  specificationId?: string;
};

export function checkDocument(document: IdsDocument): IdsIssue[] {
  const issues: IdsIssue[] = [];

  if (!document.info.title.trim()) {
    issues.push({
      severity: "error",
      where: "Document",
      message: "The document needs a title.",
    });
  }

  if (document.info.author && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(document.info.author)) {
    // The XSD constrains author with an email pattern, so this would fail
    // schema validation later — better to say so while it is being typed.
    issues.push({
      severity: "error",
      where: "Document",
      message: "The author must be an email address.",
    });
  }

  if (document.info.date && !/^\d{4}-\d{2}-\d{2}$/.test(document.info.date)) {
    issues.push({
      severity: "error",
      where: "Document",
      message: "The date must be in YYYY-MM-DD form.",
    });
  }

  if (document.specifications.length === 0) {
    issues.push({
      severity: "warning",
      where: "Document",
      message: "There are no specifications, so this file checks nothing.",
    });
  }

  const names = new Set<string>();

  for (const [index, spec] of document.specifications.entries()) {
    const where = spec.name.trim() || `Specification ${index + 1}`;
    const at = (message: string, severity: IdsIssueSeverity = "error") =>
      issues.push({ severity, where, message, specificationId: spec.id });

    if (!spec.name.trim()) at("This specification needs a name.");

    if (names.has(spec.name.trim().toLowerCase()) && spec.name.trim()) {
      at(
        "Another specification has the same name, which makes a validation report ambiguous.",
        "warning",
      );
    }
    names.add(spec.name.trim().toLowerCase());

    if (spec.ifcVersions.length === 0) {
      at("This specification declares no IFC schema.");
    }

    const applicabilityType = applicabilityCardinality(spec.applicability);

    if (spec.requirements.length === 0 && applicabilityType !== "prohibited") {
      at(
        "This specification has no requirements, so it will pass for every model.",
        "warning",
      );
    }

    if (spec.applicability.facets.length === 0) {
      if (applicabilityType === "prohibited") {
        at(
          "Applicability is empty, so this specification prohibits every entity in the model.",
          "warning",
        );
      } else if (spec.requirements.length > 0) {
        at(
          "Applicability is empty, so these requirements apply to every entity in the model. That is rarely intended.",
          "warning",
        );
      }
    }

    const min = spec.applicability.minOccurs;
    const max = spec.applicability.maxOccurs;
    if (
      typeof min === "number" &&
      typeof max === "number" &&
      min > max
    ) {
      at(`minOccurs (${min}) is greater than maxOccurs (${max}).`);
    }

    for (const { facet } of spec.applicability.facets) {
      for (const problem of checkFacet(facet)) {
        at(`Applicability — ${problem}`);
      }
    }

    for (const requirement of spec.requirements) {
      for (const problem of checkFacet(requirement.facet)) {
        at(`Requirement — ${problem}`);
      }
    }
  }

  return issues;
}

/** Problems with a facet's own values. Returns human-readable phrases. */
function checkFacet(facet: Facet): string[] {
  const label = FACET_LABELS[facet.kind];
  const problems: string[] = [];

  /** Check a value that must be present. */
  const require = (value: IdsValue | undefined, field: string) => {
    if (!value) {
      problems.push(`${label} is missing its ${field}.`);
      return;
    }
    inspect(value, field);
  };

  /**
   * Check a value that may be absent. Optional fields are where restrictions
   * usually live — "the property must exist" is the required half, "and its
   * value must be one of these" is the optional one — so skipping them would
   * miss most malformed restrictions.
   */
  const optional = (value: IdsValue | undefined, field: string) => {
    if (value) inspect(value, field);
  };

  const inspect = (value: IdsValue, field: string) => {
    if (value.kind === "simple" && !value.value.trim()) {
      problems.push(`${label} has an empty ${field}.`);
    }
    if (value.kind === "restriction" && isEmptyRestriction(value)) {
      // An xs:restriction with no facets constrains nothing, and is invalid
      // XSD besides.
      problems.push(`${label}'s ${field} is a restriction with no conditions.`);
    }
    if (value.kind === "restriction" && value.pattern) {
      try {
        new RegExp(value.pattern);
      } catch {
        problems.push(`${label}'s ${field} has a pattern that is not valid regex.`);
      }
    }
    if (value.kind === "restriction" && value.bounds) {
      const { minInclusive, maxInclusive } = value.bounds;
      if (
        minInclusive !== undefined &&
        maxInclusive !== undefined &&
        minInclusive > maxInclusive
      ) {
        problems.push(`${label}'s ${field} has a minimum above its maximum.`);
      }
    }
  };

  switch (facet.kind) {
    case "entity":
      require(facet.name, "entity name");
      optional(facet.predefinedType, "predefined type");
      break;
    case "partOf":
      require(facet.entity.name, "parent entity name");
      optional(facet.entity.predefinedType, "parent predefined type");
      break;
    case "classification":
      require(facet.system, "classification system");
      optional(facet.value, "classification value");
      break;
    case "attribute":
      require(facet.name, "attribute name");
      optional(facet.value, "attribute value");
      break;
    case "property":
      require(facet.propertySet, "property set");
      require(facet.baseName, "property name");
      optional(facet.value, "property value");
      if (facet.dataType && facet.dataType !== facet.dataType.toUpperCase()) {
        problems.push("Property data type must be all uppercase, e.g. IFCLABEL.");
      }
      break;
    case "material":
      // Every field is optional; a bare material facet legitimately means
      // "has any material at all". A malformed one still has to be caught.
      optional(facet.value, "material value");
      break;
  }

  return problems;
}

// ---------------------------------------------------------------------------
// XSD validation
// ---------------------------------------------------------------------------

export type SchemaError = {
  line?: number;
  message: string;
};

export type SchemaValidation = {
  valid: boolean;
  errors: SchemaError[];
  /** The XML that was validated, so the UI can show the offending line. */
  xml: string;
};

/**
 * Validate against the buildingSMART XSD with libxml2 (WebAssembly).
 *
 * libxml2 runs in a Web Worker (`lib/workers/xmllint.worker.ts`) — it is a
 * megabyte of WebAssembly and pure CPU, and importing it from a Client
 * Component made Turbopack resolve it for the SSR pass too, which is where it
 * intermittently failed. The schemas stay a dynamic import so nobody pays for
 * them until they press Validate.
 */
export async function validateAgainstSchema(
  document: IdsDocument,
): Promise<SchemaValidation> {
  const xml = serializeIds(document, { generator: "DiCE-IFC" });

  const schemas = await import("./schema/generated");

  const result = await validateXml({
    xml: [{ fileName: "specification.ids", contents: xml }],
    schema: [schemas.IDS_XSD],
    // The XSD imports these two; libxml2 resolves `schemaLocation` literally,
    // so they are preloaded under exactly the file names it will look for.
    preload: [
      { fileName: "xml.xsd", contents: schemas.XML_XSD },
      { fileName: "XMLSchema.xsd", contents: schemas.XML_SCHEMA_XSD },
    ],
  });

  return {
    valid: result.valid,
    xml,
    // Already normalised by the worker client.
    errors: result.errors,
  };
}
