/**
 * BCF validation, in two layers — the same split as `lib/ids/validate.ts`.
 *
 * `checkFile()` is the continuous one: cheap, synchronous, and about whether
 * the issue set is *useful* (a topic nobody is assigned, a viewpoint pointing
 * at no element, a related-topic link that goes nowhere). It runs on every
 * edit.
 *
 * `validateAgainstSchema()` is the on-demand one: it writes the real archive
 * and runs every XML file in it through libxml2 against the vendored
 * buildingSMART XSDs. libxml2 runs in a Web Worker — a megabyte of WebAssembly
 * and pure CPU — so it stays behind an explicit click. See
 * `lib/workers/xmllint.worker.ts`.
 */

import { unzipSync } from "fflate";

import { validateXml } from "@/lib/workers/xmllint-client";
import { serializeBcf, type WriteNote } from "./serialize";
import type { BcfFile, BcfTopic } from "./types";

// ---------------------------------------------------------------------------
// Authoring checks
// ---------------------------------------------------------------------------

export type CheckSeverity = "error" | "warning";

export type CheckProblem = {
  severity: CheckSeverity;
  /** Topic GUID, when the problem belongs to one. */
  topicGuid?: string;
  message: string;
};

/**
 * Problems worth surfacing while editing.
 *
 * Deliberately not a schema check: everything here would export perfectly
 * validly and still waste a reviewer's afternoon.
 */
export function checkFile(file: BcfFile): CheckProblem[] {
  const problems: CheckProblem[] = [];

  if (file.topics.length === 0) {
    problems.push({
      severity: "warning",
      message: "This file has no topics, so there is nothing to communicate.",
    });
  }

  const known = new Set(file.topics.map((topic) => topic.guid));
  const documents = new Set(file.documents.map((document_) => document_.guid));
  const seen = new Map<string, BcfTopic>();

  for (const topic of file.topics) {
    const at = topic.guid;

    if (!topic.title.trim() || topic.title === "(untitled)") {
      problems.push({
        severity: "error",
        topicGuid: at,
        message: "This topic has no title.",
      });
    }

    if (!topic.topicStatus) {
      problems.push({
        severity: "warning",
        topicGuid: at,
        message: "No status; it will be exported as “Open”.",
      });
    }

    if (!topic.description?.trim() && topic.comments.length === 0) {
      problems.push({
        severity: "warning",
        topicGuid: at,
        message: "No description and no comments — nothing says what is wrong.",
      });
    }

    if (topic.dueDate && topic.assignedTo === undefined) {
      problems.push({
        severity: "warning",
        topicGuid: at,
        message: "There is a due date but nobody is assigned.",
      });
    }

    const previous = seen.get(topic.guid);
    if (previous) {
      problems.push({
        severity: "error",
        topicGuid: at,
        message: `Duplicate topic GUID — also used by “${previous.title}”.`,
      });
    }
    seen.set(topic.guid, topic);

    for (const guid of topic.relatedTopics) {
      if (!known.has(guid)) {
        problems.push({
          severity: "warning",
          topicGuid: at,
          message: `Related topic ${short(guid)} is not in this file.`,
        });
      }
    }

    for (const reference of topic.documentReferences) {
      if (reference.documentGuid && !documents.has(reference.documentGuid)) {
        problems.push({
          severity: "error",
          topicGuid: at,
          message: "A document reference points at a document that is not in the file.",
        });
      }
    }

    const viewpointGuids = new Set(topic.viewpoints.map((v) => v.guid));
    for (const comment of topic.comments) {
      if (comment.viewpointGuid && !viewpointGuids.has(comment.viewpointGuid)) {
        problems.push({
          severity: "warning",
          topicGuid: at,
          message: "A comment points at a viewpoint that is not on this topic.",
        });
      }
      if (!comment.comment.trim()) {
        problems.push({
          severity: "warning",
          topicGuid: at,
          message: "A comment is empty.",
        });
      }
    }

    for (const viewpoint of topic.viewpoints) {
      if (!viewpoint.camera) {
        problems.push({
          severity: "warning",
          topicGuid: at,
          message:
            "A viewpoint has no camera; BCF 3.0 requires one, so a default will be written on export.",
        });
      }

      const components = viewpoint.components;
      const empty =
        !components ||
        (components.selection.length === 0 &&
          components.exceptions.length === 0 &&
          components.coloring.length === 0);

      if (empty && !viewpoint.snapshot) {
        problems.push({
          severity: "warning",
          topicGuid: at,
          message:
            "A viewpoint highlights no elements and has no snapshot — opening it will show the model unchanged.",
        });
      }
    }
  }

  return problems;
}

function short(guid: string): string {
  return guid.length > 8 ? `${guid.slice(0, 8)}…` : guid;
}

// ---------------------------------------------------------------------------
// XSD validation
// ---------------------------------------------------------------------------

export type SchemaError = {
  /** Path inside the archive, e.g. `<topic-guid>/markup.bcf`. */
  file: string;
  line?: number;
  message: string;
};

export type SchemaValidation = {
  valid: boolean;
  errors: SchemaError[];
  /** What the writer had to invent to produce a valid file. */
  notes: WriteNote[];
};

/**
 * Serialise the file and validate every XML part of the archive.
 *
 * Validating the *written archive* rather than the in-memory model is the
 * point: it is the exported bytes that another tool will read, and the writer
 * is where the schema's awkward requirements are handled. A model that looks
 * fine but exports invalid XML is exactly the bug this catches.
 */
export async function validateAgainstSchema(
  file: BcfFile,
): Promise<SchemaValidation> {
  const { bytes, notes } = serializeBcf(file);
  const errors = await validateArchive(bytes);

  return { valid: errors.length === 0, errors, notes };
}

/**
 * Validate an existing `.bcf` archive's XML against the BCF 3.0 schemas.
 *
 * Used on import too, so a file can be checked without being re-written.
 */
export async function validateArchive(bytes: Uint8Array): Promise<SchemaError[]> {
  const schemas = await import("./schema/generated");

  // Every schema except version.xsd includes shared-types.xsd, and libxml2
  // resolves `schemaLocation` literally — so it is preloaded under exactly the
  // name the includes use.
  const preload = [
    { fileName: "shared-types.xsd", contents: schemas.SHARED_TYPES_XSD },
  ];

  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();
  const errors: SchemaError[] = [];

  for (const [path, data] of Object.entries(entries)) {
    const schema = schemaFor(path, schemas);
    if (!schema) continue;

    const result = await validateXml({
      xml: [{ fileName: path, contents: decoder.decode(data) }],
      schema: [schema],
      preload,
    });

    // Already normalised by the worker client.
    for (const error of result.errors) {
      errors.push({ file: path, line: error.line, message: error.message });
    }
  }

  return errors;
}

type Schemas = typeof import("./schema/generated");

/** Which XSD governs a given entry. Anything else in the zip is not XML. */
function schemaFor(path: string, schemas: Schemas): string | null {
  const name = path.replace(/\\/g, "/").toLowerCase();

  if (name.endsWith("bcf.version")) return schemas.VERSION_XSD;
  if (name.endsWith("project.bcfp")) return schemas.PROJECT_XSD;
  if (name.endsWith("extensions.xml")) return schemas.EXTENSIONS_XSD;
  if (name.endsWith("documents.xml")) return schemas.DOCUMENTS_XSD;
  if (name.endsWith("markup.bcf")) return schemas.MARKUP_XSD;
  if (name.endsWith(".bcfv")) return schemas.VISINFO_XSD;

  return null;
}
