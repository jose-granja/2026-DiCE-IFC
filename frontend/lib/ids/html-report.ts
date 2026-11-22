/**
 * A standalone HTML report, laid out as ifclite.com's IDS report is: a header
 * card, a summary of counts and three pass rates with bars, a filter, and one
 * collapsible card per specification that opens onto its requirements (each
 * with its own checks and failing elements) and a by-element table.
 *
 * One self-contained file: no external stylesheet, no script, no image
 * requests. That is not tidiness — the report is the artefact that gets
 * emailed to a client and opened from a Downloads folder six months later, and
 * anything it fetches will be gone by then. It is also the file Phase 3 signs,
 * so it has to be exactly the bytes we produced. ifclite.com's report filters
 * and collapses with a script; here `<details>` collapses and the filter is
 * radio buttons read by CSS `:has()`, so the file stays inert.
 *
 * PDF is the browser's print dialogue rather than a bundled renderer. A PDF
 * library that lays out tables well is around half a megabyte of WebAssembly,
 * and `@page` CSS with `Ctrl-P → Save as PDF` produces a better-looking
 * document than any of them for a report that is mostly tables. The print rules
 * below are what make that true: every card printed open, repeated table
 * headers, no rows split across pages, and URLs not expanded after links.
 */

import {
  describeRequirement,
  describeRequirements,
  type AggregatedSpecification,
  type Failure,
  type FailureTranslator,
  type RequirementBreakdown,
  type ValidationRun,
} from "./report";

/** A next-intl translator scoped to the "idsReport" namespace. */
export type ReportTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * English fallback, used when no translator is supplied — engine tests build a
 * report without a next-intl context, and the app itself always passes the
 * real translator from ExportBar so the report matches the page's language.
 * The labels are `messages/en.json`'s, plurals included.
 */
function defaultReportTranslator(
  key: string,
  values?: Record<string, string | number>,
): string {
  return format(EN_REPORT_LABELS[key] ?? key, values);
}

/** `{name}` and one level of `{count, plural, one {…} other {…}}`, as next-intl reads them. */
function format(template: string, values: Record<string, string | number> = {}): string {
  const plural = template.replace(
    /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
    (_, name: string, one: string, other: string) =>
      (Number(values[name]) === 1 ? one : other).replace(/#/g, String(values[name] ?? "")),
  );
  return plural.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

const EN_REPORT_LABELS: Record<string, string> = {
  reportTitle: "IDS report — {title}",
  eyebrow: "IDS validation report",
  generatedOn: "Generated {date}",
  schemaMeta: "Schema {schemas}",
  localOnlyNote: "Every model in this report was validated in the browser. No file was uploaded.",
  summary: "Summary",
  allSatisfied: "All specifications satisfied",
  notSatisfied: "{count, plural, one {# specification not satisfied} other {# specifications not satisfied}}",
  statSpecifications: "Specifications",
  statSpecsPassed: "Specifications passed",
  statSpecsFailed: "Specifications failed",
  notApplicable: "Not applicable",
  statElementsChecked: "Elements checked",
  failingElements: "Failing elements",
  checkRate: "Check pass rate",
  checkRateDetail: "{passed} of {total} element–requirement checks passed",
  elementRate: "Element pass rate",
  elementRateDetail: "{passed} of {total} applicable elements passed every requirement",
  specRate: "Specification pass rate",
  specRateDetail: "{passed} of {total} applicable specifications passed",
  noChecks: "Nothing was checked",
  rateExplainer:
    "The three rates answer different questions. A check is one element against one requirement. An element passes only if it meets every requirement of its specification, and a specification passes only if every applicable element passes it — one failing element fails the whole specification. For a deliverable, the specification rate is the one that counts.",
  modelCol: "Model",
  schemaCol: "Schema",
  entitiesCol: "Entities",
  specifications: "Specifications",
  show: "Show",
  filterAll: "All",
  filterFailed: "Failed",
  filterPassed: "Passed",
  filterNotApplicable: "Not applicable",
  statusPass: "Pass",
  statusFail: "Fail",
  statusNA: "N/A",
  specApplicable: "{count, plural, one {# applicable element} other {# applicable elements}}",
  specPassed: "{count} passed",
  specFailed: "{count} failed",
  elementsPassedRate: "{rate} of elements passed",
  checksPassed: "{passed} of {total} checks passed ({rate})",
  requirements: "Requirements",
  optional: "optional",
  prohibited: "prohibited",
  byElement: "By element",
  classCol: "Class",
  nameCol: "Name",
  globalIdCol: "GlobalId",
  idCol: "ID",
  reasonCol: "Reason",
  whyFailedCol: "Why it failed",
  unnamed: "unnamed",
  selectHint: "Click to select",
  evaluationFailed: "The specification could not be evaluated",
  countFailed: "The specification’s count is not met",
  nothingApplied: "No element matched this specification.",
  allPassed: "Every applicable element passed every requirement.",
  andMore: "…and {count} more. Export BCF for the complete set.",
  footerGenerator: "DiCE-IFC IDS validator",
  footerModels: "{count, plural, one {# model} other {# models}}",
  footerSpecifications: "{count, plural, one {# specification} other {# specifications}}",
  footerValidated: "validated {start}–{end}",
};

/**
 * Row caps. A report listing 40,000 rows is a browser hang, and the BCF export
 * is the right artefact for working through them; what is cut is always
 * stated with its count.
 */
const REQUIREMENT_ROWS = 100;
const ELEMENT_ROWS = 500;

type Context = {
  t: ReportTranslator;
  tFailure?: FailureTranslator;
  number: Intl.NumberFormat;
  percent: (rate: number) => string;
  /** The model column is noise when one model was validated. */
  federated: boolean;
};

export function renderHtmlReport(
  run: ValidationRun,
  t: ReportTranslator = defaultReportTranslator,
  tFailure?: FailureTranslator,
  locale = "en",
): string {
  const number = new Intl.NumberFormat(locale);
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const context: Context = {
    t,
    tFailure,
    number,
    percent: (rate) => `${decimal.format(rate)}%`,
    federated: run.models.length > 1,
  };

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
    header(run, context),
    summary(run, context),
    specifications(run, context),
    footer(run, context),
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

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * Floored to one decimal, never rounded: 99.96% shown as "100%" while an
 * element is still failing is the one thing a compliance report must not say.
 * `null` when nothing was counted, which is not 100%.
 */
export function passRate(passed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.floor((passed / total) * 1000) / 10;
}

/** Element–requirement checks: every applicable element against every requirement. */
function checksOf(specification: AggregatedSpecification) {
  if (specification.applicableCount === 0) return { passed: 0, total: 0 };
  return specification.requirements.reduce(
    (sum, requirement) => ({
      passed: sum.passed + requirement.passedCount,
      total: sum.total + requirement.passedCount + requirement.failedCount,
    }),
    { passed: 0, total: 0 },
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function header(run: ValidationRun, { t, number }: Context): string {
  const schemas = [...new Set(run.models.map((model) => model.schemaVersion))].join(", ");

  return `
<header class="card">
  <p class="eyebrow">${escapeHtml(t("eyebrow"))}</p>
  <h1>${escapeHtml(run.idsTitle)}</h1>
  <p class="meta">
    <span>${escapeHtml(t("generatedOn", { date: formatDate(run.finishedAt) }))}</span>
    ${schemas ? `<span>${escapeHtml(t("schemaMeta", { schemas }))}</span>` : ""}
  </p>
  <p class="meta note">${escapeHtml(t("localOnlyNote"))}</p>
  <table class="models">
    <thead><tr><th>${escapeHtml(t("modelCol"))}</th><th>${escapeHtml(t("schemaCol"))}</th><th class="num">${escapeHtml(t("entitiesCol"))}</th></tr></thead>
    <tbody>
      ${run.models
        .map(
          (model) =>
            `<tr><td>${escapeHtml(model.name)}</td><td>${escapeHtml(model.schemaVersion)}</td><td class="num">${number.format(model.entityCount)}</td></tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>
</header>`;
}

function summary(run: ValidationRun, context: Context): string {
  const { t, number } = context;
  const { summary: s } = run;
  const verdict = s.failed === 0 ? "pass" : "fail";

  const checks = run.specifications.map(checksOf).reduce(
    (sum, next) => ({ passed: sum.passed + next.passed, total: sum.total + next.total }),
    { passed: 0, total: 0 },
  );
  const elementsPassed = run.specifications.reduce((sum, spec) => sum + spec.passedCount, 0);
  const applicableSpecifications = s.passed + s.failed;

  return `
<section class="card">
  <h2>${escapeHtml(t("summary"))}</h2>
  <div class="verdict ${verdict}">
    ${s.failed === 0 ? escapeHtml(t("allSatisfied")) : escapeHtml(t("notSatisfied", { count: s.failed }))}
  </div>
  <div class="stats">
    ${stat(t("statSpecifications"), number.format(s.totalSpecifications), "")}
    ${stat(t("statSpecsPassed"), number.format(s.passed), "pass")}
    ${stat(t("statSpecsFailed"), number.format(s.failed), s.failed > 0 ? "fail" : "")}
    ${stat(t("notApplicable"), number.format(s.notApplicable), "")}
    ${stat(t("statElementsChecked"), number.format(s.totalChecks), "")}
    ${stat(t("failingElements"), number.format(s.failingEntities), s.failingEntities > 0 ? "fail" : "pass")}
  </div>
  <div class="rates">
    ${rate(
      t("checkRate"),
      passRate(checks.passed, checks.total),
      t("checkRateDetail", { passed: number.format(checks.passed), total: number.format(checks.total) }),
      context,
    )}
    ${rate(
      t("elementRate"),
      passRate(elementsPassed, s.totalChecks),
      t("elementRateDetail", { passed: number.format(elementsPassed), total: number.format(s.totalChecks) }),
      context,
    )}
    ${rate(
      t("specRate"),
      passRate(s.passed, applicableSpecifications),
      t("specRateDetail", { passed: number.format(s.passed), total: number.format(applicableSpecifications) }),
      context,
    )}
  </div>
  <p class="explainer">${escapeHtml(t("rateExplainer"))}</p>
</section>`;
}

function stat(label: string, value: string, tone: string): string {
  return `<div class="stat ${tone}"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(label)}</span></div>`;
}

function rate(label: string, value: number | null, detail: string, { t, percent }: Context): string {
  return `<div class="rate">
      <div class="rate-head"><span class="rate-value">${value === null ? "—" : escapeHtml(percent(value))}</span><span class="rate-label">${escapeHtml(label)}</span></div>
      ${value === null ? "" : bar(value)}
      <div class="rate-detail">${escapeHtml(value === null ? t("noChecks") : detail)}</div>
    </div>`;
}

function bar(value: number): string {
  return `<div class="bar"><div class="bar-fill" style="width:${value}%"></div></div>`;
}

function specifications(run: ValidationRun, context: Context): string {
  const { t, number } = context;
  const count = (status: string) =>
    run.specifications.filter((specification) => specification.status === status).length;

  const filters = [
    ["all", t("filterAll"), run.specifications.length],
    ["fail", t("filterFailed"), count("fail")],
    ["pass", t("filterPassed"), count("pass")],
    ["not_applicable", t("filterNotApplicable"), count("not_applicable")],
  ] as const;

  return `
<section class="card">
  <div class="toolbar" role="radiogroup" aria-label="${escapeHtml(t("show"))}">
    <span class="toolbar-label">${escapeHtml(t("show"))}</span>
    ${filters
      .map(
        ([value, label, total]) =>
          `<label class="filter"><input type="radio" name="show" id="show-${value}"${value === "all" ? " checked" : ""}><span>${escapeHtml(label)} <span class="filter-count">${number.format(total)}</span></span></label>`,
      )
      .join("\n    ")}
  </div>
  <h2>${escapeHtml(t("specifications"))}</h2>
  ${run.specifications.map((specification) => specificationCard(specification, context)).join("\n")}
</section>`;
}

function specificationCard(specification: AggregatedSpecification, context: Context): string {
  const { t, number, percent } = context;
  const status = specification.status;
  const checks = checksOf(specification);
  const checkRate = passRate(checks.passed, checks.total);
  const elementRate = passRate(specification.passedCount, specification.applicableCount);
  const cardinalityFailed = specification.cardinality?.passed === false;

  const stats = [
    `<span>${escapeHtml(t("specApplicable", { count: specification.applicableCount }))}</span>`,
    ...(specification.applicableCount > 0
      ? [
          `<span class="pass-text">${escapeHtml(t("specPassed", { count: specification.passedCount }))}</span>`,
          `<span class="fail-text">${escapeHtml(t("specFailed", { count: specification.failedCount }))}</span>`,
          `<span>${escapeHtml(t("elementsPassedRate", { rate: percent(elementRate ?? 0) }))}</span>`,
        ]
      : []),
    ...(checkRate !== null
      ? [
          `<span>${escapeHtml(
            t("checksPassed", {
              passed: number.format(checks.passed),
              total: number.format(checks.total),
              rate: percent(checkRate),
            }),
          )}</span>`,
        ]
      : []),
  ];

  const alerts = [
    ...specification.errors.map((error) =>
      alert(t("evaluationFailed"), `${error.message} (${error.modelName})`),
    ),
    ...(cardinalityFailed && specification.cardinality
      ? [alert(t("countFailed"), `${specification.cardinality.message} (${specification.cardinality.modelName})`)]
      : []),
  ];

  const body =
    specification.applicableCount === 0
      ? alerts.length > 0
        ? ""
        : `<p class="empty">${escapeHtml(t("nothingApplied"))}</p>`
      : `
      <h4>${escapeHtml(t("requirements"))}</h4>
      ${specification.requirements.map((requirement) => requirementBlock(requirement, context)).join("\n")}
      ${specification.failures.length > 0 ? byElement(specification.failures, context) : `<p class="empty pass-text">${escapeHtml(t("allPassed"))}</p>`}`;

  return `
  <details class="spec ${status}"${status === "fail" ? " open" : ""}>
    <summary class="spec-head">
      <span class="chevron" aria-hidden="true">▶</span>
      <div class="spec-info">
        <h3>${badge(status, t)} ${escapeHtml(specification.name)}</h3>
        ${specification.description ? `<p class="spec-desc">${escapeHtml(specification.description)}</p>` : ""}
        <div class="spec-stats">${stats.join("")}</div>
        ${elementRate === null ? "" : bar(elementRate)}
      </div>
    </summary>
    <div class="spec-body">
      ${alerts.join("\n")}
      ${body}
    </div>
  </details>`;
}

function alert(title: string, message: string): string {
  return `<div class="alert"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
}

function badge(status: string, t: ReportTranslator): string {
  const label = status === "pass" ? t("statusPass") : status === "fail" ? t("statusFail") : t("statusNA");
  return `<span class="badge ${status}">${escapeHtml(label)}</span>`;
}

function requirementBlock(
  requirement: RequirementBreakdown,
  context: Context,
): string {
  const { t, number, percent } = context;
  const total = requirement.passedCount + requirement.failedCount;
  const value = passRate(requirement.passedCount, total);
  const status = requirement.failedCount > 0 ? "fail" : "pass";
  const shown = requirement.failures.slice(0, REQUIREMENT_ROWS);

  return `<div class="req ${status}">
        <div class="req-head">
          ${badge(status, t)}
          <span class="req-label">${escapeHtml(requirement.label)}</span>
          ${requirement.optionality !== "required" ? `<span class="tag">${escapeHtml(t(requirement.optionality))}</span>` : ""}
        </div>
        ${requirement.instructions ? `<p class="req-note">${escapeHtml(requirement.instructions)}</p>` : ""}
        <div class="req-stats">${escapeHtml(
          t("checksPassed", {
            passed: number.format(requirement.passedCount),
            total: number.format(total),
            rate: percent(value ?? 0),
          }),
        )}</div>
        ${
          shown.length > 0
            ? `<table class="elements">
          ${elementHead(context, t("reasonCol"))}
          <tbody>
            ${shown
              .map((failure) =>
                elementRow(failure, context, escapeHtml(describeRequirement(failure.requirements[0], context.tFailure))),
              )
              .join("\n            ")}
          </tbody>
        </table>
        ${more(requirement.failures.length - shown.length, t)}`
            : ""
        }
      </div>`;
}

function byElement(failures: Failure[], context: Context): string {
  const { t, number, tFailure } = context;
  const shown = failures.slice(0, ELEMENT_ROWS);

  return `
      <details class="by-element">
        <summary>${escapeHtml(t("byElement"))} <span class="filter-count">${number.format(failures.length)}</span></summary>
        <table class="elements">
          ${elementHead(context, t("whyFailedCol"))}
          <tbody>
            ${shown
              .map((failure) =>
                elementRow(failure, context, describeRequirements(failure, tFailure).map(escapeHtml).join("<br>")),
              )
              .join("\n            ")}
          </tbody>
        </table>
        ${more(failures.length - shown.length, t)}
      </details>`;
}

function elementHead({ t, federated }: Context, reason: string): string {
  return `<thead><tr>
            <th class="col-class">${escapeHtml(t("classCol"))}</th>
            <th class="col-name">${escapeHtml(t("nameCol"))}</th>
            <th class="col-guid">${escapeHtml(t("globalIdCol"))}</th>
            <th class="col-id num">${escapeHtml(t("idCol"))}</th>
            ${federated ? `<th class="col-model">${escapeHtml(t("modelCol"))}</th>` : ""}
            <th>${escapeHtml(reason)}</th>
          </tr></thead>`;
}

/** `reason` is already HTML: escaped text, possibly joined with `<br>`. */
function elementRow(failure: Failure, { t, federated }: Context, reason: string): string {
  return `<tr>
              <td class="col-class">${escapeHtml(failure.type)}</td>
              <td>${failure.name ? escapeHtml(failure.name) : `<em>${escapeHtml(t("unnamed"))}</em>`}</td>
              <td class="col-guid">${failure.globalId ? `<code title="${escapeHtml(t("selectHint"))}">${escapeHtml(failure.globalId)}</code>` : "—"}</td>
              <td class="col-id num">${failure.expressId}</td>
              ${federated ? `<td>${escapeHtml(failure.modelName)}</td>` : ""}
              <td class="reason">${reason}</td>
            </tr>`;
}

function more(hidden: number, t: ReportTranslator): string {
  return hidden > 0 ? `<p class="more">${escapeHtml(t("andMore", { count: hidden }))}</p>` : "";
}

function footer(run: ValidationRun, { t }: Context): string {
  return `
<footer>
  <strong>${escapeHtml(t("footerGenerator"))}</strong> ·
  ${escapeHtml(t("footerModels", { count: run.models.length }))} ·
  ${escapeHtml(t("footerSpecifications", { count: run.specifications.length }))} ·
  ${escapeHtml(t("footerValidated", { start: formatDate(run.startedAt), end: formatTime(run.finishedAt) }))}
</footer>`;
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
:root {
  color-scheme: light;
  --pass: #16a34a; --pass-ink: #166534; --pass-bg: #dcfce7; --pass-line: #86efac;
  --fail: #dc2626; --fail-ink: #991b1b; --fail-bg: #fef2f2; --fail-line: #fca5a5;
  --warn-bg: #fffbeb; --warn-line: #fcd34d;
  --ink: #1e293b; --muted: #64748b; --line: #e2e8f0; --soft: #f1f5f9;
  --page: #f8fafc; --card: #fff;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 20px; max-width: 1200px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--ink); background: var(--page);
}
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.2rem; margin: 0 0 12px; }
h3 { font-size: 1rem; margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h4 { margin: 0 0 10px; font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
p { margin: 0; }
.card {
  background: var(--card); border-radius: 8px; padding: 20px; margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
}
.eyebrow { color: var(--muted); font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2px; }
.meta { color: var(--muted); font-size: .85rem; margin-top: 4px; }
.meta span { margin-right: 16px; }
.note { font-style: italic; }

table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th {
  padding: 7px 10px; text-align: left; background: var(--page); color: var(--muted);
  font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
  border-bottom: 2px solid var(--line); white-space: nowrap;
}
td { padding: 7px 10px; border-bottom: 1px solid var(--soft); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
table.models { margin-top: 14px; }

.verdict { font-weight: 600; padding: 10px 14px; border-radius: 6px; border: 1px solid; margin-bottom: 12px; }
.verdict.pass { background: var(--pass-bg); border-color: var(--pass-line); color: var(--pass-ink); }
.verdict.fail { background: var(--fail-bg); border-color: var(--fail-line); color: var(--fail-ink); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 12px; background: var(--page); border: 1px solid var(--line); border-radius: 8px;
}
.stat .value { font-size: 1.75rem; font-weight: 700; line-height: 1.2; }
.stat .label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
.stat.pass .value { color: var(--pass); }
.stat.fail .value { color: var(--fail); }

.rates { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 16px; }
.rate { padding: 12px; background: var(--page); border: 1px solid var(--line); border-radius: 8px; }
.rate-head { display: flex; align-items: baseline; gap: 8px; }
.rate-value { font-size: 1.5rem; font-weight: 700; }
.rate-label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
.rate-detail { color: var(--muted); font-size: .8rem; margin-top: 4px; }
.explainer { color: var(--muted); font-size: .8rem; margin-top: 12px; line-height: 1.6; }

.bar { height: 8px; background: var(--fail-bg); border-radius: 4px; overflow: hidden; margin: 8px 0 2px; }
.bar-fill { height: 100%; background: var(--pass); border-radius: 4px; }

.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.toolbar-label { color: var(--muted); font-size: .8rem; margin-right: 4px; }
.filter input { position: absolute; opacity: 0; pointer-events: none; }
.filter > span {
  display: inline-block; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); font-size: .8rem; font-weight: 500; cursor: pointer;
}
.filter > span:hover { background: var(--soft); }
.filter input:checked + span { background: var(--ink); border-color: var(--ink); color: #fff; }
.filter input:focus-visible + span { outline: 2px solid #3b82f6; outline-offset: 2px; }
.filter-count { opacity: .65; font-variant-numeric: tabular-nums; margin-left: 2px; }
body:has(#show-fail:checked) .spec:not(.fail),
body:has(#show-pass:checked) .spec:not(.pass),
body:has(#show-not_applicable:checked) .spec:not(.not_applicable) { display: none; }

.badge {
  display: inline-block; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line);
  font-size: .68rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  background: var(--soft); color: var(--muted); white-space: nowrap;
}
.badge.pass { background: var(--pass-bg); color: var(--pass-ink); border-color: var(--pass-line); }
.badge.fail { background: var(--fail-bg); color: var(--fail-ink); border-color: var(--fail-line); }
.pass-text { color: var(--pass); }
.fail-text { color: var(--fail); }

.spec { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
.spec-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px; cursor: pointer; list-style: none; }
.spec-head::-webkit-details-marker { display: none; }
.spec-head:hover { background: var(--soft); }
.chevron { color: var(--muted); font-size: .8rem; margin-top: 4px; transition: transform .2s; }
.spec[open] > .spec-head .chevron { transform: rotate(90deg); }
.spec-info { flex: 1; min-width: 0; }
.spec-desc { color: var(--muted); font-size: .85rem; margin-top: 4px; }
.spec-stats { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); font-size: .8rem; margin-top: 8px; }
.spec-stats .pass-text { color: var(--pass); }
.spec-stats .fail-text { color: var(--fail); }
.spec-body { border-top: 1px solid var(--line); padding: 16px; }
.empty { color: var(--muted); font-size: .85rem; }

.alert {
  display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; padding: 10px 12px;
  border: 1px solid var(--fail-line); background: var(--fail-bg); color: var(--fail-ink);
  border-radius: 6px; font-size: .82rem;
}

.req { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.req.pass { background: var(--pass-bg); border-color: var(--pass-line); }
.req.fail { background: var(--warn-bg); border-color: var(--warn-line); }
.req-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.req-label { font-size: .85rem; }
.tag { font-size: .68rem; color: var(--muted); border: 1px solid var(--line); background: var(--card); border-radius: 3px; padding: 0 5px; }
.req-note { color: var(--muted); font-size: .78rem; font-style: italic; margin-top: 2px; }
.req-stats { color: var(--muted); font-size: .8rem; margin-top: 4px; }
.req table.elements { margin-top: 10px; background: var(--card); }

.elements { table-layout: fixed; }
.elements td { overflow-wrap: anywhere; }
.elements td.col-class { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .76rem; }
.col-class { width: 140px; }
.col-name { width: 18%; }
.col-guid { width: 200px; }
.col-id { width: 64px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.col-model { width: 15%; }
.reason { color: var(--fail-ink); }
code {
  font: .74rem ui-monospace, "SF Mono", Menlo, monospace; background: var(--soft);
  padding: 2px 6px; border-radius: 3px; word-break: break-all; user-select: all; cursor: text;
}
.more { color: var(--muted); font-size: .76rem; font-style: italic; margin-top: 6px; }

.by-element { margin-top: 14px; }
.by-element > summary { cursor: pointer; color: var(--muted); font-size: .85rem; padding: 6px 0; }
.by-element > summary:hover { color: var(--ink); }

footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 12px 20px 20px; }

@media (max-width: 720px) {
  body { padding: 12px; }
  .col-guid, .col-id { display: none; }
}

@media print {
  /* Save-as-PDF is the PDF story; these rules are what make it read well. */
  @page { margin: 14mm; }
  body { background: #fff; padding: 0; max-width: none; font-size: 10pt; }
  .card { box-shadow: none; border: 1px solid var(--line); }
  .toolbar, .chevron { display: none; }
  /* A closed card prints open: a report on paper has nothing to click. The
     app's print button opens them too, for browsers without ::details-content. */
  details::details-content { content-visibility: visible; display: block; }
  body .spec { display: block; }
  /* Repeat the header on every page a long table spans. */
  thead { display: table-header-group; }
  tr, .stat, .rate, .verdict, .req-head, .alert { break-inside: avoid; }
  .bar, .bar-fill, .badge, .req, .verdict, .alert { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  /* Without this, print stylesheets that expand href after links turn every
     cell into a wall of URLs. There are no links here, and there should be
     none if this is ever templated. */
  a::after { content: none; }
}
`;
