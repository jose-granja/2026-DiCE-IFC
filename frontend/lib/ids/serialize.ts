/**
 * IDS 1.0 XML writer.
 *
 * This is the half no library provides — parsers and validators exist, authors
 * do not. It is written by hand against `lib/ids/schema/ids.xsd` rather than
 * through a generic XML builder, because the schema's constraints are mostly
 * about *order* and *which attribute is legal where*, and a generic builder
 * would happily emit a well-formed document that no validator accepts.
 *
 * Deliberately string-based rather than DOM-based: it must run identically in a
 * Web Worker and in Node tests, and the output has to be byte-stable so a saved
 * draft and a re-export compare equal.
 */

import {
  FACET_SEQUENCE,
  IDS_NAMESPACE,
  IDS_SCHEMA_LOCATION,
  isEmptyRestriction,
  type Applicability,
  type Facet,
  type FacetKind,
  type IdsDocument,
  type IdsValue,
  type Requirement,
  type RestrictionValue,
  type Specification,
} from "./types";

const INDENT = "  ";

export type SerializeOptions = {
  /** Emitted as an XML comment, so the file says what produced it. */
  generator?: string;
};

export function serializeIds(
  document: IdsDocument,
  options: SerializeOptions = {},
): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  if (options.generator) {
    lines.push(`<!-- ${escapeComment(options.generator)} -->`);
  }

  // Built by joining an array rather than by concatenating template literals.
  // The production minifier mis-folded the `+` chain here and silently dropped
  // the two xmlns declarations, emitting `...buildingsmart.org/IDSxsi:schema...`
  // — malformed XML, in the production bundle only. Unit tests never see it
  // because Vitest does not minify; `e2e/ids-create.spec.ts` asserts the built
  // output parses, which is what caught it.
  const rootAttributes = [
    `xmlns="${IDS_NAMESPACE}"`,
    'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    `xsi:schemaLocation="${IDS_SCHEMA_LOCATION}"`,
  ].join(" ");

  lines.push(`<ids ${rootAttributes}>`);

  lines.push(...info(document, 1));
  lines.push(...specifications(document.specifications, 1));
  lines.push("</ids>");

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// <info>
// ---------------------------------------------------------------------------

function info(document: IdsDocument, depth: number): string[] {
  const lines = [indent(depth) + "<info>"];
  const { info: meta } = document;

  // Order is the XSD's sequence, not the object's key order. Emitting `author`
  // before `description` produces a file every validator rejects.
  push(lines, depth + 1, "title", meta.title);
  push(lines, depth + 1, "copyright", meta.copyright);
  push(lines, depth + 1, "version", meta.version);
  push(lines, depth + 1, "description", meta.description);
  push(lines, depth + 1, "author", meta.author);
  push(lines, depth + 1, "date", meta.date);
  push(lines, depth + 1, "purpose", meta.purpose);
  push(lines, depth + 1, "milestone", meta.milestone);

  lines.push(indent(depth) + "</info>");
  return lines;
}

function push(lines: string[], depth: number, tag: string, value?: string) {
  // An empty optional element is not the same as an absent one: `<version/>`
  // fails `xs:string` minLength checks in some profiles and carries no meaning.
  if (value === undefined || value === "") return;
  lines.push(`${indent(depth)}<${tag}>${escapeText(value)}</${tag}>`);
}

// ---------------------------------------------------------------------------
// <specifications>
// ---------------------------------------------------------------------------

function specifications(list: Specification[], depth: number): string[] {
  const lines = [indent(depth) + "<specifications>"];
  for (const spec of list) lines.push(...specification(spec, depth + 1));
  lines.push(indent(depth) + "</specifications>");
  return lines;
}

function specification(spec: Specification, depth: number): string[] {
  const attributes = [
    attribute("name", spec.name),
    // `ifcVersion` is an xs:list — space-separated tokens, not repeated
    // attributes.
    attribute("ifcVersion", spec.ifcVersions.join(" ")),
    attribute("identifier", spec.identifier),
    attribute("description", spec.description),
    attribute("instructions", spec.instructions),
  ]
    .filter(Boolean)
    .join("");

  const lines = [`${indent(depth)}<specification${attributes}>`];
  lines.push(...applicability(spec.applicability, depth + 1));
  lines.push(...requirements(spec.requirements, depth + 1));
  lines.push(indent(depth) + "</specification>");
  return lines;
}

function applicability(block: Applicability, depth: number): string[] {
  const attributes = [
    block.minOccurs === undefined ? "" : attribute("minOccurs", String(block.minOccurs)),
    block.maxOccurs === undefined ? "" : attribute("maxOccurs", String(block.maxOccurs)),
  ].join("");

  if (block.facets.length === 0) {
    // Legal, and it means "every entity in the model". Self-closing keeps that
    // explicit rather than looking like a truncated element.
    return [`${indent(depth)}<applicability${attributes}/>`];
  }

  const lines = [`${indent(depth)}<applicability${attributes}>`];
  for (const { facet } of ordered(block.facets.map((f) => ({ facet: f.facet })))) {
    lines.push(...facetElement(facet, depth + 1));
  }
  lines.push(indent(depth) + "</applicability>");
  return lines;
}

function requirements(list: Requirement[], depth: number): string[] {
  if (list.length === 0) {
    return [`${indent(depth)}<requirements/>`];
  }

  const lines = [`${indent(depth)}<requirements>`];
  for (const requirement of ordered(list)) {
    lines.push(
      ...facetElement(requirement.facet, depth + 1, {
        cardinality: requirement.cardinality,
        instructions: requirement.instructions,
      }),
    );
  }
  lines.push(indent(depth) + "</requirements>");
  return lines;
}

/**
 * Sort facets into the XSD's sequence order, keeping the author's ordering
 * within each kind.
 *
 * The editor lets facets be reordered freely because that is how people think
 * about them; the file has to be in schema order regardless. Doing it here
 * rather than in the UI means the UI cannot get it wrong.
 */
function ordered<T extends { facet: Facet }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      FACET_SEQUENCE.indexOf(a.facet.kind) - FACET_SEQUENCE.indexOf(b.facet.kind),
  );
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

type FacetAttributes = { cardinality?: string; instructions?: string };

function facetElement(
  facet: Facet,
  depth: number,
  extra: FacetAttributes = {},
): string[] {
  const common =
    attribute("cardinality", extra.cardinality) +
    attribute("instructions", extra.instructions);

  switch (facet.kind) {
    case "entity": {
      const lines = [`${indent(depth)}<entity${common}>`];
      lines.push(...valueElement("name", facet.name, depth + 1));
      if (facet.predefinedType) {
        lines.push(
          ...valueElement("predefinedType", facet.predefinedType, depth + 1),
        );
      }
      lines.push(indent(depth) + "</entity>");
      return lines;
    }

    case "partOf": {
      const relation = attribute("relation", facet.relation);
      const lines = [`${indent(depth)}<partOf${relation}${common}>`];
      // The nested entity carries no cardinality of its own.
      lines.push(...facetElement(facet.entity, depth + 1));
      lines.push(indent(depth) + "</partOf>");
      return lines;
    }

    case "classification": {
      const uri = attribute("uri", facet.uri);
      const lines = [`${indent(depth)}<classification${uri}${common}>`];
      // `value` precedes `system` in the sequence, even though `system` is the
      // required one.
      if (facet.value) lines.push(...valueElement("value", facet.value, depth + 1));
      lines.push(...valueElement("system", facet.system, depth + 1));
      lines.push(indent(depth) + "</classification>");
      return lines;
    }

    case "attribute": {
      const lines = [`${indent(depth)}<attribute${common}>`];
      lines.push(...valueElement("name", facet.name, depth + 1));
      if (facet.value) lines.push(...valueElement("value", facet.value, depth + 1));
      lines.push(indent(depth) + "</attribute>");
      return lines;
    }

    case "property": {
      const attrs =
        attribute("dataType", facet.dataType) +
        attribute("uri", facet.uri) +
        common;
      const lines = [`${indent(depth)}<property${attrs}>`];
      lines.push(...valueElement("propertySet", facet.propertySet, depth + 1));
      lines.push(...valueElement("baseName", facet.baseName, depth + 1));
      if (facet.value) lines.push(...valueElement("value", facet.value, depth + 1));
      lines.push(indent(depth) + "</property>");
      return lines;
    }

    case "material": {
      const uri = attribute("uri", facet.uri);
      if (!facet.value) {
        return [`${indent(depth)}<material${uri}${common}/>`];
      }
      const lines = [`${indent(depth)}<material${uri}${common}>`];
      lines.push(...valueElement("value", facet.value, depth + 1));
      lines.push(indent(depth) + "</material>");
      return lines;
    }
  }
}

// ---------------------------------------------------------------------------
// ids:idsValue
// ---------------------------------------------------------------------------

function valueElement(tag: string, value: IdsValue, depth: number): string[] {
  if (value.kind === "simple") {
    return [
      `${indent(depth)}<${tag}>`,
      `${indent(depth + 1)}<simpleValue>${escapeText(value.value)}</simpleValue>`,
      `${indent(depth)}</${tag}>`,
    ];
  }

  // An `xs:restriction` with no facets constrains nothing and is invalid
  // (`xs:restriction` requires content). Degrade to an empty simpleValue, which
  // at least round-trips, rather than emitting something unparseable.
  if (isEmptyRestriction(value)) {
    return [
      `${indent(depth)}<${tag}>`,
      `${indent(depth + 1)}<simpleValue></simpleValue>`,
      `${indent(depth)}</${tag}>`,
    ];
  }

  const lines = [
    `${indent(depth)}<${tag}>`,
    `${indent(depth + 1)}<xs:restriction base="${value.base}">`,
    ...restrictionFacets(value, depth + 2),
    `${indent(depth + 1)}</xs:restriction>`,
    `${indent(depth)}</${tag}>`,
  ];
  return lines;
}

function restrictionFacets(value: RestrictionValue, depth: number): string[] {
  const lines: string[] = [];

  for (const item of value.enumeration ?? []) {
    lines.push(`${indent(depth)}<xs:enumeration value="${escapeAttr(item)}"/>`);
  }

  if (value.pattern) {
    lines.push(
      `${indent(depth)}<xs:pattern value="${escapeAttr(value.pattern)}"/>`,
    );
  }

  for (const facet of ["minInclusive", "maxInclusive", "minExclusive", "maxExclusive"] as const) {
    const bound = value.bounds?.[facet];
    if (bound !== undefined) {
      lines.push(`${indent(depth)}<xs:${facet} value="${bound}"/>`);
    }
  }

  for (const facet of ["length", "minLength", "maxLength"] as const) {
    const size = value.length?.[facet];
    if (size !== undefined) {
      lines.push(`${indent(depth)}<xs:${facet} value="${size}"/>`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function indent(depth: number): string {
  return INDENT.repeat(depth);
}

function attribute(name: string, value?: string): string {
  if (value === undefined || value === "") return "";
  return ` ${name}="${escapeAttr(value)}"`;
}

export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

/** `--` terminates an XML comment, so it cannot appear inside one. */
function escapeComment(value: string): string {
  return value.replace(/--+/g, "-");
}

/** Filename for a document, from its title. */
export function idsFileName(document: IdsDocument): string {
  const base = document.info.title.trim() || "specification";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "specification"}.ids`;
}

export type { FacetKind };
