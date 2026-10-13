/**
 * A standalone HTML report.
 *
 * One self-contained file: no stylesheet, no script, no image requests. That is
 * not tidiness — the report is the artefact that gets emailed to a client and
 * opened from a Downloads folder six months later, and anything it fetches will
 * be gone by then. It is also the file Phase 3 signs, so it has to be exactly
 * the bytes we produced.
 *
 * PDF is the browser's print dialogue rather than a bundled renderer. A PDF
 * library that lays out tables well is around half a megabyte of WebAssembly,
 * and `@page` CSS with `Ctrl-P → Save as PDF` produces a better-looking
 * document than any of them for a report that is mostly tables. The print rules
 * below are what make that true: repeated table headers, no rows split across
 * pages, and URLs not expanded after links.
 */

import { describeRequirements, type FailureTranslator, type ValidationRun } from "./report";

/** A next-intl translator scoped to the "idsReport" namespace. */
export type ReportTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * English fallback, used when no translator is supplied — engine tests build a
 * report without a next-intl context, and the app itself always passes the
 * real translator from ExportBar so the report matches the page's language.
 */
function defaultReportTranslator(
  key: string,
  values?: Record<string, string | number>,
): string {
  const count = Number(values?.count ?? 0);
  switch (key) {
    case "notSatisfied":
      return `${count} specification${count === 1 ? "" : "s"} not satisfied`;
    case "footerModels":
      return `${count} model${count === 1 ? "" : "s"}`;
    case "footerSpecifications":
      return `${count} specification${count === 1 ? "" : "s"}`;
    default:
      return interpolate(EN_REPORT_LABELS[key] ?? key, values);
  }
}

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

const EN_REPORT_LABELS: Record<string, string> = {
  reportTitle: "IDS report — {title}",
  generatedBy: "IDS validation report · generated {date} · DiCE-IFC",
  localOnlyNote: "Every model in this report was validated in the browser. No file was uploaded.",
  allSatisfied: "All specifications satisfied",
  passed: "Passed",
  failed: "Failed",
  notApplicable: "Not applicable",
  failingElements: "Failing elements",
  checks: "Checks",
  passRate: "Pass rate",
  models: "Models",
  modelCol: "Model",
  schemaCol: "Schema",
  entitiesCol: "Entities",
  specifications: "Specifications",
  specificationCol: "Specification",
  statusCol: "Status",
  applicableCol: "Applicable",
  statusPass: "Pass",
  statusFail: "Fail",
  statusNA: "N/A",
  elementCol: "Element",
  classCol: "Class",
  whyFailedCol: "Why it failed",
  andMore: "…and {count} more. Export BCF for the complete set.",
  footerValidated: "validated {start}–{end}",
};

export function renderHtmlReport(
  run: ValidationRun,
  t: ReportTranslator = defaultReportTranslator,
  tFailure?: FailureTranslator,
  locale = "en",
): string {
  const failed = run.specifications.filter((s) => s.status === "fail");

  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(locale)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(t("reportTitle", { title: run.idsTitle }))}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    header(run, t),
    summary(run, t),
    models(run, t),
    specificationTable(run, t),
    ...failed.map((specification) => failureSection(specification, t, tFailure)),
    footer(run, t),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function reportFileName(run: ValidationRun): string {
  const base = run.idsTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${base || "ids-report"}-${run.finishedAt.slice(0, 10)}.html`;
}

function header(run: ValidationRun, t: ReportTranslator): string {
  return `
<header>
  <h1>${escapeHtml(run.idsTitle)}</h1>
  <p class="meta">
    ${escapeHtml(t("generatedBy", { date: formatDate(run.finishedAt) }))}
  </p>
  <p class="meta note">
    ${escapeHtml(t("localOnlyNote"))}
  </p>
</header>`;
}

function summary(run: ValidationRun, t: ReportTranslator): string {
  const { summary: s } = run;
  const verdict = s.failed === 0 ? "pass" : "fail";

  return `
<section class="summary">
  <div class="verdict ${verdict}">
    ${s.failed === 0 ? escapeHtml(t("allSatisfied")) : escapeHtml(t("notSatisfied", { count: s.failed }))}
  </div>
  <div class="tiles">
    ${tile(t("passed"), s.passed, "pass")}
    ${tile(t("failed"), s.failed, "fail")}
    ${tile(t("notApplicable"), s.notApplicable, "na")}
    ${tile(t("failingElements"), s.failingEntities, s.failingEntities > 0 ? "fail" : "pass")}
    ${tile(t("checks"), s.totalChecks, "na")}
    ${tile(t("passRate"), `${s.passRate.toFixed(1)}%`, verdict)}
  </div>
</section>`;
}

function tile(label: string, value: string | number, tone: string): string {
  return `<div class="tile ${tone}"><span class="value">${escapeHtml(String(value))}</span><span class="label">${escapeHtml(label)}</span></div>`;
}

function models(run: ValidationRun, t: ReportTranslator): string {
  return `
<section>
  <h2>${escapeHtml(t("models"))}</h2>
  <table>
    <thead><tr><th>${escapeHtml(t("modelCol"))}</th><th>${escapeHtml(t("schemaCol"))}</th><th class="num">${escapeHtml(t("entitiesCol"))}</th></tr></thead>
    <tbody>
      ${run.models
        .map(
          (model) =>
            `<tr><td>${escapeHtml(model.name)}</td><td>${escapeHtml(model.schemaVersion)}</td><td class="num">${model.entityCount.toLocaleString("en-GB")}</td></tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>
</section>`;
}

function specificationTable(run: ValidationRun, t: ReportTranslator): string {
  return `
<section>
  <h2>${escapeHtml(t("specifications"))}</h2>
  <table>
    <thead>
      <tr>
        <th>${escapeHtml(t("specificationCol"))}</th><th>${escapeHtml(t("statusCol"))}</th>
        <th class="num">${escapeHtml(t("applicableCol"))}</th><th class="num">${escapeHtml(t("passed"))}</th>
        <th class="num">${escapeHtml(t("failed"))}</th><th class="num">${escapeHtml(t("passRate"))}</th>
      </tr>
    </thead>
    <tbody>
      ${run.specifications
        .map(
          (specification) => `<tr>
        <td>${escapeHtml(specification.name)}</td>
        <td><span class="pill ${specification.status}">${statusLabel(specification.status, t)}</span></td>
        <td class="num">${specification.applicableCount}</td>
        <td class="num">${specification.passedCount}</td>
        <td class="num">${specification.failedCount}</td>
        <td class="num">${specification.applicableCount === 0 ? "—" : `${specification.passRate.toFixed(1)}%`}</td>
      </tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>
</section>`;
}

function failureSection(
  specification: ValidationRun["specifications"][number],
  t: ReportTranslator,
  tFailure: FailureTranslator | undefined,
): string {
  // Capped per specification. A report listing 40,000 rows is a browser hang,
  // and the BCF export is the right artefact for working through them.
  const shown = specification.failures.slice(0, 500);
  const hidden = specification.failures.length - shown.length;

  return `
<section class="failures">
  <h2>${escapeHtml(specification.name)}</h2>
  ${specification.description ? `<p class="meta">${escapeHtml(specification.description)}</p>` : ""}
  ${
    specification.cardinality && !specification.cardinality.passed
      ? `<p class="cardinality">${escapeHtml(specification.cardinality.message)} (${escapeHtml(specification.cardinality.modelName)})</p>`
      : ""
  }
  <table>
    <thead>
      <tr><th>${escapeHtml(t("elementCol"))}</th><th>${escapeHtml(t("classCol"))}</th><th>${escapeHtml(t("modelCol"))}</th><th>${escapeHtml(t("whyFailedCol"))}</th></tr>
    </thead>
    <tbody>
      ${shown
        .map(
          (failure) => `<tr>
        <td>${escapeHtml(failure.name ?? `#${failure.expressId}`)}<br><span class="guid">${escapeHtml(failure.globalId ?? `express id ${failure.expressId}`)}</span></td>
        <td>${escapeHtml(failure.type)}</td>
        <td>${escapeHtml(failure.modelName)}</td>
        <td>${describeRequirements(failure, tFailure).map(escapeHtml).join("<br>")}</td>
      </tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>
  ${hidden > 0 ? `<p class="meta">${escapeHtml(t("andMore", { count: hidden }))}</p>` : ""}
</section>`;
}

function footer(run: ValidationRun, t: ReportTranslator): string {
  return `
<footer>
  <p class="meta">
    ${escapeHtml(t("footerModels", { count: run.models.length }))} ·
    ${escapeHtml(t("footerSpecifications", { count: run.specifications.length }))} ·
    ${escapeHtml(t("footerValidated", { start: formatDate(run.startedAt), end: formatTime(run.finishedAt) }))}
  </p>
</footer>`;
}

function statusLabel(status: string, t: ReportTranslator): string {
  if (status === "pass") return t("statusPass");
  if (status === "fail") return t("statusFail");
  return t("statusNA");
}

/**
 * Fixed format, deliberately.
 *
 * `toLocaleString()` renders differently depending on who opens the file, and a
 * report is a record — two people reading the same signed document should not
 * see two different dates.
 */
function formatDate(value: string): string {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : value;
}

function formatTime(value: string): string {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(11, 16) : value;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 2.5rem 1.5rem; max-width: 60rem;
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #16191d; background: #fff;
}
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .6rem; }
.meta { color: #5b6470; font-size: .8125rem; margin: .15rem 0; }
.note { font-style: italic; }
header { border-bottom: 2px solid #16191d; padding-bottom: 1rem; }
.verdict {
  font-weight: 600; padding: .6rem .85rem; border-radius: .35rem;
  margin: 1.25rem 0 .85rem; border: 1px solid;
}
.verdict.pass { background: #eaf7ef; border-color: #2f9e6f; color: #14603f; }
.verdict.fail { background: #fdecec; border-color: #d24b4b; color: #8a2020; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .5rem; }
.tile {
  border: 1px solid #dde1e6; border-radius: .35rem; padding: .6rem .75rem;
  display: flex; flex-direction: column; gap: .1rem;
}
.tile .value { font-size: 1.35rem; font-weight: 600; }
.tile .label { color: #5b6470; font-size: .75rem; }
.tile.pass .value { color: #14603f; }
.tile.fail .value { color: #8a2020; }
table { width: 100%; border-collapse: collapse; margin-top: .4rem; font-size: .8125rem; }
th, td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid #e6e9ed; vertical-align: top; }
th { background: #f5f6f8; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.guid { color: #7b8492; font-size: .7rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.pill { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .7rem; font-weight: 600; }
.pill.pass { background: #eaf7ef; color: #14603f; }
.pill.fail { background: #fdecec; color: #8a2020; }
.pill.not_applicable { background: #eef0f3; color: #5b6470; }
.cardinality { color: #8a2020; font-size: .8125rem; }
footer { margin-top: 2.5rem; border-top: 1px solid #e6e9ed; padding-top: .75rem; }

@media print {
  /* Save-as-PDF is the PDF story; these rules are what make it read well. */
  @page { margin: 14mm; }
  body { padding: 0; max-width: none; font-size: 10.5pt; }
  /* Repeat the header on every page a long table spans. */
  thead { display: table-header-group; }
  tr, .tile, .verdict { break-inside: avoid; }
  section.failures { break-before: page; }
  /* Without this, print stylesheets that expand href after links turn every
     cell into a wall of URLs. There are no links here, and there should be
     none if this is ever templated. */
  a::after { content: none; }
}
`;
