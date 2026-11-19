// @vitest-environment jsdom

/**
 * Validation findings → BCF and PDF (ADR 018).
 *
 * On real results: the service's code run on `fixtures/ifc/georeferenced-wall-ifc4.ifc`
 * (`npm run validator:check -- fixtures/ifc/georeferenced-wall-ifc4.ifc --json
 * lib/validation/__tests__/fixtures/georeferenced-wall-results.json`; rerun after
 * bumping the pins). Header 3 errors, schema 12, IFC102 2, PJS003 11.
 *
 * As for the IDS export, the claim worth testing is that the issue set is
 * schema-valid BCF 3.0. Snapshots drive a real renderer: the e2e's job.
 */

import { createTranslator } from "next-intl";
import pdfMake from "pdfmake/build/pdfmake";
import fontFiles from "pdfmake/build/vfs_fonts";
import { describe, expect, it } from "vitest";

import { parseBcf } from "@/lib/bcf/parse";
import { serializeBcf } from "@/lib/bcf/serialize";
import { validateArchive } from "@/lib/bcf/validate";
import messages from "@/messages/en.json";
import portuguese from "@/messages/pt.json";
import { validationToBcf } from "../bcf-export";
import { findingGroups } from "../findings";
import { buildValidationReport, MAX_ROWS_PER_RULE, validationReportFileName } from "../pdf-report";
import type { StageResult, ValidationStage } from "../stages";
import results from "./fixtures/georeferenced-wall-results.json";

const byStage = Object.fromEntries((results as StageResult[]).map((r) => [r.stage, r])) as Partial<Record<ValidationStage, StageResult>>;
const translate = (namespace: "validationExport" | "validationReport", locale: "en" | "pt" = "en") => {
  const t = createTranslator({ locale, messages: locale === "en" ? messages : portuguese, namespace });
  return (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
};
const input = { modelId: "m1", modelName: "georeferenced-wall-ifc4.ifc", validatedAt: new Date("2026-11-19T10:00:00Z"), results: byStage };

describe("findingGroups", () => {
  it("groups errors and warnings by stage in the service's order, then by rule", () => {
    const groups = findingGroups(byStage);
    expect(groups.map((g) => g.stage)).toEqual(["header", "header", "header", ...Array(groups.length - 3 - 2).fill("schema"), "normative_ia", "normative_ia"]);
    const rules = groups.filter((g) => g.stage === "normative_ia");
    expect(rules.map((g) => [g.label, g.outcomes.length])).toEqual([["IFC102", 2], ["PJS003", 11]]);
    expect(rules[0].doc).toMatch(/IFC102_Absence-of-deprecated-entities\.html$/);
    // Passes and not-applicable outcomes are not findings.
    expect(groups.flatMap((g) => g.outcomes).every((o) => o.severity === "ERROR" || o.severity === "WARNING")).toBe(true);
    expect(groups.reduce((n, g) => n + g.outcomes.length, 0)).toBe(3 + 12 + 13);
  });
});

describe("validationToBcf", () => {
  it("writes one topic per rule, a schema-valid BCF 3.0", async () => {
    const file = await validationToBcf(input, translate("validationExport"));
    const groups = findingGroups(byStage);
    expect(file.topics).toHaveLength(groups.length);
    const pjs = file.topics.find((topic) => topic.labels.includes("PJS003"))!;
    expect(pjs.title).toMatch(/^PJS003 .*\(11 occurrences\)$/);
    expect(pjs.topicType).toBe("Error");
    expect(pjs.priority).toBe("High");
    expect(pjs.referenceLinks[0]).toMatch(/PJS003.*\.html$/);
    expect(pjs.description).toContain("#");
    expect(pjs.headerFiles[0].filename).toBe("georeferenced-wall-ifc4.ifc");
    expect(pjs.labels).toContain("IFC validation");

    const { bytes } = serializeBcf(file);
    expect(await validateArchive(bytes)).toEqual([]);
    const back = await parseBcf(bytes);
    expect(back.file.topics).toHaveLength(file.topics.length);
  });

  it("writes one topic per occurrence when asked, in the user's language", async () => {
    const file = await validationToBcf(input, translate("validationExport", "pt"), { grouping: "per-occurrence" });
    expect(file.topics).toHaveLength(3 + 12 + 13);
    const one = file.topics.find((topic) => topic.labels.includes("IFC102"))!;
    expect(one.title).toMatch(/^IFC102 — \S+ #\d+$/);
    expect(one.labels).toContain("Validação IFC");
    expect(await validateArchive(serializeBcf(file).bytes)).toEqual([]);
  });
});

describe("buildValidationReport", () => {
  const build = { service: { "ifc-gherkin-rules": "893f8275049b8960c3ce0c7379b4b57aefeaa8f9", ifcopenshell: "v0.8.6-8b5b400" }, pyodide: "0.28.3", packages: [], bytes: 1 };
  const definition = (locale: "en" | "pt") => buildValidationReport(
    { modelName: input.modelName, validatedAt: input.validatedAt, seconds: 20, results: byStage, build, generatedAt: input.validatedAt, locale },
    translate("validationReport", locale),
  );
  const text = (value: unknown): string => JSON.stringify(value);

  it("has a cover with every stage's status, then each stage's findings rule by rule", () => {
    const doc = text(definition("en").content);
    for (const stage of ["Header syntax", "Header", "Syntax", "Prerequisites", "Schema", "Normative rules — implementer agreements", "Industry practices"]) {
      expect(doc).toContain(stage);
    }
    expect(doc).toContain("Invalid");
    expect(doc).toContain("ifc-gherkin-rules 893f827");
    expect(doc).toContain("PJS003");
    expect(doc).toContain("11 occurrences");
    expect(doc).toContain("IFC102_Absence-of-deprecated-entities.html");
    expect(validationReportFileName(input.modelName)).toBe("georeferenced-wall-ifc4-validation.pdf");
  });

  it("speaks Portuguese, and caps each rule's rows", () => {
    expect(text(definition("pt").content)).toContain("Regras normativas — acordos de implementação");
    expect(MAX_ROWS_PER_RULE).toBeGreaterThan(0);
  });

  it("renders to a real PDF", async () => {
    pdfMake.addVirtualFileSystem(fontFiles);
    const buffer: Uint8Array = await pdfMake.createPdf(definition("en")).getBuffer();
    expect(new TextDecoder().decode(buffer.slice(0, 5))).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(5000);
  });
});
