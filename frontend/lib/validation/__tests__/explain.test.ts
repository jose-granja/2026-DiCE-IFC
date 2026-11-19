/**
 * What a finding means, in words (`explain.ts`) — on the service's real output
 * (`fixtures/georeferenced-wall-results.json`, see exports.test.ts) and on the
 * header Revit writes, which the service reports as four findings.
 */

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "@/messages/en.json";
import portuguese from "@/messages/pt.json";
import { validationToBcf } from "../bcf-export";
import { docLabel, groupExplanation, groupTitle, outcomeNote } from "../explain";
import { describeValue, findingGroups } from "../findings";
import { buildValidationReport } from "../pdf-report";
import type { StageResult, ValidationStage } from "../stages";
import results from "./fixtures/georeferenced-wall-results.json";

const byStage = Object.fromEntries((results as StageResult[]).map((r) => [r.stage, r])) as Partial<Record<ValidationStage, StageResult>>;
const explainer = (locale: "en" | "pt" = "en") => {
  const t = createTranslator({ locale, messages: locale === "en" ? messages : portuguese, namespace: "validationExplain" });
  return (key: string, values?: Record<string, string | number>) => t(key as never, values as never);
};
const explain = explainer();

/** The header as the service reports Revit 2024's: a two-part originating system, and the three fields read from it. */
const REVIT = "Autodesk Revit 24.0.5.432 (ENG) - IFC 24.2.0.49";
const DOC = "https://github.com/buildingSMART/IFC4.x-IF/tree/main/docs/IFC-file-header";
const revitHeader: StageResult = {
  stage: "header",
  status: "invalid",
  info: {},
  outcomes: [
    { severity: "ERROR", outcome_code: "E00020", feature: "originating_system", observed: REVIT, doc: DOC },
    ...["company_name", "application_name", "version"].map((feature) => ({
      severity: "ERROR" as const, outcome_code: "E00020", feature, observed: null, doc: DOC, source: REVIT,
    })),
    // As the driver reports VNGaia_example.ifc: a right ViewDefinition, and a free-text entry that stops IfcOpenShell reading it.
    { severity: "WARNING", outcome_code: "E00020", feature: "description", doc: DOC, expected: ["ReferenceView_V1.2", "IFC4Precast"], schema: "IFC4",
      observed: ["ViewDefinition [ReferenceView_V1.2]", "ExchangeRequirement [Architecture]", "Re-exported by ifc-lite, 2 modifications"],
      reason: "unreadable", unreadable: ["Re-exported by ifc-lite, 2 modifications"] },
  ],
};

describe("header findings", () => {
  const groups = findingGroups({ header: revitHeader });

  it("are one finding per field, not one per outcome code — the originating system first, then what is read from it", () => {
    expect(groups.map((g) => [g.label, g.outcomes.length])).toEqual([
      ["originating_system", 1], ["company_name", 1], ["application_name", 1], ["version", 1], ["description", 1],
    ]);
    expect(groups.every((g) => g.kind === "header")).toBe(true);
  });

  it("say what the originating system must be, and what the file has instead", () => {
    const origin = groups.find((g) => g.label === "originating_system")!;
    expect(groupTitle(origin, explain)).toBe("Originating system (FILE_NAME)");
    expect(groupExplanation(origin, explain)).toContain("“Company - Application - Version”");
    expect(outcomeNote(origin.outcomes[0], origin, explain)).toBe(`In the file: “${REVIT}” — 2 parts separated by “ - ”, where three are needed.`);
    expect(docLabel(origin, explain)).toMatch(/header/i);
  });

  it("say a field read from the originating system is empty because of it", () => {
    const version = groups.find((g) => g.label === "version")!;
    expect(groupExplanation(version, explain)).toContain("PEP 440");
    expect(outcomeNote(version.outcomes[0], version, explain)).toBe(`Empty, because it could not be read from the originating system “${REVIT}”.`);
  });

  it("name the views allowed for the file's schema, and the entry that kept the view from being read", () => {
    const view = groups.find((g) => g.label === "description")!;
    expect(groupExplanation(view, explain)).toContain("Allowed for IFC4: ReferenceView_V1.2, IFC4Precast");
    const note = outcomeNote(view.outcomes[0], view, explain)!;
    expect(note).toContain("must be “Keyword [value]”, and “Re-exported by ifc-lite, 2 modifications” is not");
    const notAllowed = { ...view.outcomes[0], reason: "notAllowed", views: ["CoordinationView_V2.0"], unreadable: null };
    expect(outcomeNote(notAllowed, view, explain)).toBe("The file declares “CoordinationView_V2.0”, which is not a view allowed for IFC4.");
  });

  it("speak Portuguese", () => {
    const origin = groups.find((g) => g.label === "originating_system")!;
    expect(groupExplanation(origin, explainer("pt"))).toContain("“Empresa - Aplicação - Versão”");
  });
});

describe("schema and rule findings", () => {
  const groups = findingGroups(byStage);

  it("give the schema's own sentence, why it was violated, and the entity's documentation", () => {
    const guid = groups.find((g) => g.stage === "schema" && g.label === "IfcGloballyUniqueId base64 validation")!;
    expect(guid.outcomes.length).toBeGreaterThan(0);
    expect(groupExplanation(guid, explain)).toBe("The attribute GlobalId should be valid base64 encoded 128-bit number.");
    expect(outcomeNote(guid.outcomes[0], guid, explain)).toBe("Why: Guid first character must be either a 0, 1, 2, or 3.");
    expect(guid.doc).toMatch(/IFC4\/ADD2_TC1\/HTML\/link\/ifcgloballyuniqueid\.htm$/);
  });

  it("say a missing required attribute in a sentence", () => {
    const group = findingGroups({
      schema: { stage: "schema", status: "invalid", info: {}, outcomes: [
        { severity: "ERROR", inst: 5, entity: "IfcOwnerHistory", type: "schema", attribute: "IfcOwnerHistory.CreationDate", title: "Attribute not optional" },
      ] },
    })[0];
    expect(groupTitle(group, explain)).toBe("IfcOwnerHistory.CreationDate is missing");
    expect(groupExplanation(group, explain)).toBe("CreationDate is a required attribute of IfcOwnerHistory, but the file leaves it unset ($). Fill it in the authoring tool, or report it to the exporter’s vendor.");
  });

  it("give a rule's description from its feature file", () => {
    const pjs = groups.find((g) => g.label === "PJS003")!;
    expect(groupExplanation(pjs, explain)).toMatch(/^The rule verifies that the GUID/);
  });

  it("show a rule's wrapped value as the value", () => {
    expect(describeValue({ schema_identifier: "STANDARD" })).toBe("STANDARD");
    expect(describeValue({ oneOf: ["0", "1"] })).toBe('{"oneOf":["0","1"]}');
  });
});

describe("exports, explained", () => {
  it("put the explanation in the BCF topic and the PDF", async () => {
    const input = { modelId: "m1", modelName: "revit.ifc", validatedAt: new Date("2026-11-19T10:00:00Z"), results: { ...byStage, header: revitHeader } };
    const t = createTranslator({ locale: "en", messages, namespace: "validationExport" });
    const file = await validationToBcf(input, (key, values) => t(key as never, values as never), { explain });
    const origin = file.topics.find((topic) => topic.labels.includes("originating_system"))!;
    expect(origin.title).toContain("Originating system (FILE_NAME)");
    expect(origin.description).toContain("“Company - Application - Version”");
    expect(origin.description).toContain("2 parts separated by");

    const tr = createTranslator({ locale: "en", messages, namespace: "validationReport" });
    const pdf = JSON.stringify(buildValidationReport({
      modelName: "revit.ifc", validatedAt: input.validatedAt, seconds: 1, results: input.results, build: null,
      generatedAt: input.validatedAt, locale: "en", explain,
    }, (key, values) => tr(key as never, values as never)).content);
    expect(pdf).toContain("Company - Application - Version");
    expect(pdf).toContain("Why: Guid first character");
  });
});
