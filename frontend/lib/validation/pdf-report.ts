/**
 * A PDF report of an IFC validation run (ADR 018): a cover with the model, the
 * date, what was run (the service's pinned versions) and each stage's status,
 * then every stage's findings, rule by rule, each with its occurrences.
 *
 * Pure: words through `t` (keys under `validationReport`), no React, no canvas —
 * the panel loads pdfmake and renders it, as the BCF report does. Nothing leaves
 * the browser.
 */

import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";

import { describeValue, findingGroups } from "./findings";
import { groupExplanation, groupTitle, outcomeNote, type ExplainTranslate } from "./explain";
import { VALIDATION_STAGES, type StageResult, type ValidationStage, type ValidatorBuild } from "./stages";

export type ReportTranslate = (key: string, values?: Record<string, string | number>) => string;

export type ValidationReportInput = {
  modelName: string;
  validatedAt: Date;
  /** Seconds the run took. */
  seconds: number;
  results: Partial<Record<ValidationStage, StageResult>>;
  build: ValidatorBuild | null;
  generatedAt: Date;
  locale: string;
  /** Says what each finding means (`explain.ts`, `validationExplain`); without it, the service's own words. */
  explain?: ExplainTranslate;
};

/** Occurrences listed per rule; the rest are counted. A rule can have thousands. */
export const MAX_ROWS_PER_RULE = 200;

const MARGIN = 40;
const ACCENT = "#1e3a8a";
const MUTED = "#64748b";
const STATUS_COLOUR: Record<string, string> = {
  valid: "#15803d", warning: "#b45309", invalid: "#b91c1c", skipped: MUTED, failed: "#b91c1c",
};

export function validationReportFileName(modelName: string): string {
  const base = modelName.replace(/\.[^.]+$/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "model"}-validation.pdf`;
}

export function buildValidationReport(input: ValidationReportInput, t: ReportTranslate): TDocumentDefinitions {
  const dateTime = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium", timeStyle: "short" });
  const groups = findingGroups(input.results);
  const ran = VALIDATION_STAGES.filter((stage) => input.results[stage]);
  const service = input.build?.service ?? {};

  const content: Content[] = [
    { text: t("eyebrow"), style: "eyebrow" },
    { text: input.modelName, style: "documentTitle" },
    keyValues([
      [t("validated"), dateTime.format(input.validatedAt)],
      [t("duration"), t("seconds", { seconds: Math.round(input.seconds) })],
      [t("where"), t("whereValue")],
      [t("rules"), service["ifc-gherkin-rules"] ? `ifc-gherkin-rules ${service["ifc-gherkin-rules"].slice(0, 7)}` : "—"],
      [t("engine"), [service.ifcopenshell && `IfcOpenShell (${t("serviceRuns", { version: service.ifcopenshell })})`, input.build && `Pyodide ${input.build.pyodide}`].filter(Boolean).join(" · ") || "—"],
    ]),
    { text: t("stagesTitle"), style: "sectionTitle" },
    {
      table: {
        headerRows: 1,
        widths: ["*", 70, 60],
        body: [
          [t("stage"), t("status"), t("findings")].map((text, i): TableCell => ({ text, style: "tableHeader", alignment: i === 2 ? "right" : "left" })),
          ...ran.map((stage): TableCell[] => {
            const result = input.results[stage]!;
            const count = result.outcomes.filter((o) => o.severity === "ERROR" || o.severity === "WARNING").length;
            return [
              t(`stages.${stage}`),
              { text: t(`statuses.${result.status}`), color: STATUS_COLOUR[result.status] ?? MUTED, bold: true },
              { text: count ? String(count) : "—", alignment: "right" },
            ];
          }),
        ],
      },
      layout: "lightHorizontalLines",
    },
  ];

  if (groups.length === 0) {
    content.push({ text: t("noFindings"), margin: [0, 14, 0, 0], color: STATUS_COLOUR.valid, bold: true });
  }

  for (const stage of ran) {
    const result = input.results[stage]!;
    const stageGroups = groups.filter((g) => g.stage === stage);
    const crashed = result.info.crashed ?? [];
    if (stageGroups.length === 0 && crashed.length === 0 && result.status !== "skipped" && result.status !== "failed") continue;
    content.push({ text: t(`stages.${stage}`), style: "sectionTitle", pageBreak: "before" });
    if (result.status === "skipped") content.push({ text: t("skipped", { stage: t(`stages.${result.info.reason}`) }), color: MUTED });
    if (result.status === "failed") content.push({ text: t("failed", { reason: result.info.reason ?? "" }), color: STATUS_COLOUR.failed });
    for (const crash of crashed) content.push({ text: t("crashed", { rule: crash.rule, error: crash.error }), style: "small", margin: [0, 0, 0, 4] });

    for (const group of stageGroups) {
      const shown = group.outcomes.slice(0, MAX_ROWS_PER_RULE);
      const explain = input.explain;
      const explanation = explain ? groupExplanation(group, explain) : null;
      content.push({
        stack: [
          {
            text: [
              { text: group.severity === "ERROR" ? `${t("error")} · ` : `${t("warning")} · `, color: group.severity === "ERROR" ? STATUS_COLOUR.invalid : STATUS_COLOUR.warning, bold: true },
              { text: explain ? groupTitle(group, explain) : group.title, bold: true },
              { text: `  (${t("occurrences", { count: group.outcomes.length })})`, color: MUTED },
            ],
            margin: [0, 10, 0, 2],
          },
          ...(explanation ? [{ text: explanation, fontSize: 8, margin: [0, 0, 0, 3] } as Content] : []),
          ...(group.doc ? [{ text: group.doc, link: group.doc, style: "link", fontSize: 7.5, margin: [0, 0, 0, 4] } as Content] : []),
        ],
        unbreakable: true,
      });
      content.push({
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: [52, 90, "*", "*"],
          body: [
            [t("instance"), t("entity"), t("expected"), t("observed")].map((text): TableCell => ({ text, style: "tableHeader" })),
            ...shown.map((o): TableCell[] => {
              // Explained, an occurrence says what was found in words; the service's raw values otherwise.
              const note = explain ? outcomeNote(o, group, explain) : null;
              return [
                o.inst ? `#${o.inst}` : "—",
                o.entity ?? "",
                note ? "" : describeValue(o.expected, 400),
                note ?? describeValue(o.observed, 400),
              ];
            }),
          ],
        },
        layout: "lightHorizontalLines",
        fontSize: 7.5,
      });
      if (group.outcomes.length > shown.length) {
        content.push({ text: t("andMore", { count: group.outcomes.length - shown.length }), style: "small", margin: [0, 2, 0, 0] });
      }
    }
  }

  return {
    info: { title: `${t("eyebrow")} — ${input.modelName}`, creator: "DiCE-IFC" },
    pageSize: "A4",
    pageMargins: [MARGIN, 48, MARGIN, 48],
    content,
    defaultStyle: { font: "Roboto", fontSize: 9.5, color: "#0f172a", lineHeight: 1.2 },
    styles: {
      eyebrow: { fontSize: 9, bold: true, color: "#475569", margin: [0, 0, 0, 6] },
      documentTitle: { fontSize: 20, bold: true, color: ACCENT, margin: [0, 0, 0, 14] },
      sectionTitle: { fontSize: 13, bold: true, color: ACCENT, margin: [0, 14, 0, 6] },
      tableHeader: { bold: true, color: "#334155", fillColor: "#f1f5f9" },
      small: { fontSize: 8, color: MUTED },
      link: { color: "#1d4ed8" },
    },
    footer: (page, total) => ({
      columns: [
        { text: input.modelName, fontSize: 7.5, color: MUTED },
        { text: t("page", { page, total }), alignment: "right", fontSize: 7.5, color: MUTED },
      ],
      margin: [MARGIN, 16, MARGIN, 0],
    }),
  };
}

function keyValues(rows: Array<[string, string]>): Content {
  return {
    table: { widths: [110, "*"], body: rows.map(([key, value]): TableCell[] => [{ text: key, color: MUTED }, value]) },
    layout: "noBorders",
    margin: [0, 0, 0, 8],
  };
}
