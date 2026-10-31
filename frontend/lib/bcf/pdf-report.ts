/**
 * A PDF report of BCF topics — what goes round a coordination meeting, or to
 * someone with no BCF tool at all.
 *
 * A cover with the counts by status, a summary table whose rows link to the
 * topics, then one page per topic: its fields, description, every viewpoint's
 * snapshot (annotations included, since they are in the image) and the
 * comment thread.
 *
 * Pure: the snapshots arrive already decoded to data URLs (`report-images.ts`,
 * which needs a browser), and the words through `t`, so the document is built
 * and tested without React or a canvas. Everything stays in the browser.
 */

import type { Content, ContentStack, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";

import type { BcfFile, BcfTopic, BcfViewpoint } from "./types";
import { describeViewpoint } from "./viewpoint";

export type ReportTranslate = (key: string, values?: Record<string, string | number>) => string;

/** Which topics are in the report, as the cover says it. */
export type ReportScope = "all" | "filtered" | "selected";

export type BcfReportInput = {
  file: BcfFile;
  /** The topics to report, in report order. */
  topics: BcfTopic[];
  scope: ReportScope;
  /** Who made the report, when the panel knows. */
  author?: string;
  generatedAt: Date;
  locale: string;
  /** Each viewpoint's snapshot as an image data URL, by viewpoint guid; missing when it has none or it could not be read. */
  images: ReadonlyMap<string, string>;
};

const PAGE_WIDTH = 595.28;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ACCENT = "#1e3a8a";
const MUTED = "#64748b";

export function bcfReportFileName(file: BcfFile): string {
  const base = (file.project.name || file.name.replace(/\.bcf(zip)?$/i, "") || "issues")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "issues"}-report.pdf`;
}

export function buildBcfReport(input: BcfReportInput, t: ReportTranslate): TDocumentDefinitions {
  const { file, topics, generatedAt, locale } = input;
  const dates = dateFormatters(locale);
  const title = file.project.name || file.name.replace(/\.bcf(zip)?$/i, "") || t("untitledProject");
  const anchor = (index: number) => `topic-${index + 1}`;

  const content: Content[] = [
    { text: t("eyebrow"), style: "eyebrow" },
    { text: title, style: "documentTitle" },
    keyValueTable(
      [
        [t("generated"), dates.dateTime(generatedAt.toISOString())],
        [t("generatedBy"), input.author ?? ""],
        [t("scope"), t(`scopes.${input.scope}`, { count: topics.length, total: file.topics.length })],
        [t("source"), file.name],
      ],
      [0, 0, 0, 16],
    ),
  ];

  if (topics.length === 0) {
    content.push({ text: t("noTopics"), color: MUTED });
  } else {
    content.push({ text: t("byStatus"), style: "sectionTitle" });
    content.push(countTable(topics, t));
    content.push({ text: t("summary"), style: "sectionTitle" });
    content.push(summaryTable(topics, t, dates, anchor));
  }

  topics.forEach((topic, index) => {
    content.push(...topicSection(topic, index, anchor(index), input.images, t, dates));
  });

  return {
    info: { title: `${t("eyebrow")} — ${title}`, creator: "DiCE-IFC", author: input.author || undefined },
    pageSize: "A4",
    pageMargins: [MARGIN, 48, MARGIN, 48],
    content,
    defaultStyle: { font: "Roboto", fontSize: 9.5, color: "#0f172a", lineHeight: 1.2 },
    styles: {
      eyebrow: { fontSize: 9, bold: true, color: "#475569", margin: [0, 0, 0, 6] },
      documentTitle: { fontSize: 20, bold: true, color: ACCENT, margin: [0, 0, 0, 14] },
      sectionTitle: { fontSize: 12, bold: true, color: ACCENT, margin: [0, 14, 0, 6] },
      topicTitle: { fontSize: 15, bold: true, color: ACCENT, margin: [0, 0, 0, 8] },
      subTitle: { fontSize: 10.5, bold: true, color: ACCENT, margin: [0, 12, 0, 5] },
      tableHeader: { bold: true, color: "#334155", fillColor: "#f1f5f9" },
      small: { fontSize: 8, color: MUTED },
      link: { color: "#1d4ed8" },
    },
    footer: (page, total) => ({
      columns: [
        { text: title, fontSize: 7.5, color: MUTED },
        { text: t("page", { page, total }), alignment: "right", fontSize: 7.5, color: MUTED },
      ],
      margin: [MARGIN, 16, MARGIN, 0],
    }),
  };
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

function countTable(topics: BcfTopic[], t: ReportTranslate): Content {
  const counts = new Map<string, number>();
  for (const topic of topics) {
    const status = topic.topicStatus?.trim() || t("none");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return {
    table: {
      headerRows: 1,
      widths: ["*", 60],
      body: [
        [
          { text: t("fields.status"), style: "tableHeader" },
          { text: t("topics"), style: "tableHeader", alignment: "right" },
        ],
        ...[...counts].map(([status, count]): TableCell[] => [status, { text: String(count), alignment: "right" }]),
      ],
    },
    layout: "lightHorizontalLines",
  };
}

function summaryTable(
  topics: BcfTopic[],
  t: ReportTranslate,
  dates: DateFormatters,
  anchor: (index: number) => string,
): Content {
  const header = ["#", t("fields.title"), t("fields.status"), t("fields.priority"), t("fields.assignedTo"), t("fields.dueDate")];
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: [20, "*", 58, 52, 90, 58],
      body: [
        header.map((text): TableCell => ({ text, style: "tableHeader" })),
        ...topics.map((topic, index): TableCell[] => [
          { text: String(index + 1), color: MUTED },
          // Each row is a link to the topic's own page.
          { text: topic.title || t("untitledTopic"), linkToDestination: anchor(index), style: "link" },
          topic.topicStatus ?? "",
          topic.priority ?? "",
          topic.assignedTo ?? "",
          topic.dueDate ? dates.date(topic.dueDate) : "",
        ]),
      ],
    },
    layout: "lightHorizontalLines",
    fontSize: 8.5,
  };
}

// ---------------------------------------------------------------------------
// A topic
// ---------------------------------------------------------------------------

function topicSection(
  topic: BcfTopic,
  index: number,
  id: string,
  images: ReadonlyMap<string, string>,
  t: ReportTranslate,
  dates: DateFormatters,
): Content[] {
  const out: Content[] = [
    {
      text: `${index + 1}. ${topic.title || t("untitledTopic")}`,
      style: "topicTitle",
      id,
      pageBreak: "before",
    },
  ];

  const created = [topic.creationAuthor, topic.creationDate && dates.dateTime(topic.creationDate)].filter(Boolean).join(" · ");
  const modified = [topic.modifiedAuthor, topic.modifiedDate && dates.dateTime(topic.modifiedDate)].filter(Boolean).join(" · ");
  out.push(
    keyValueTable([
      [t("fields.status"), topic.topicStatus ?? ""],
      [t("fields.priority"), topic.priority ?? ""],
      [t("fields.type"), topic.topicType ?? ""],
      [t("fields.stage"), topic.stage ?? ""],
      [t("fields.labels"), topic.labels.join(", ")],
      [t("fields.assignedTo"), topic.assignedTo ?? ""],
      [t("fields.dueDate"), topic.dueDate ? dates.date(topic.dueDate) : ""],
      [t("fields.created"), created],
      [t("fields.modified"), modified],
    ]),
  );

  if (topic.description?.trim()) {
    out.push({ text: t("description"), style: "subTitle" }, { text: topic.description });
  }

  if (topic.viewpoints.length > 0) {
    out.push({ text: t("viewpoints", { count: topic.viewpoints.length }), style: "subTitle" });
    out.push(...viewpointImages(topic.viewpoints, images, t));
  }

  if (topic.comments.length > 0) {
    const viewpointNumber = new Map(topic.viewpoints.map((viewpoint, i) => [viewpoint.guid, i + 1]));
    out.push({ text: t("comments", { count: topic.comments.length }), style: "subTitle" });
    for (const comment of topic.comments) {
      const on = comment.viewpointGuid && viewpointNumber.get(comment.viewpointGuid);
      out.push({
        stack: [
          {
            text: [
              { text: comment.author || t("unknownAuthor"), bold: true },
              { text: `  ${comment.date ? dates.dateTime(comment.date) : ""}`, color: MUTED, fontSize: 8 },
              on ? { text: `  ${t("onViewpoint", { number: on })}`, color: MUTED, fontSize: 8 } : "",
            ],
          },
          { text: comment.comment, margin: [0, 2, 0, 0] },
        ],
        margin: [0, 0, 0, 7],
        unbreakable: true,
      });
    }
  }

  const references = [
    ...topic.referenceLinks.map((link): Content => ({ text: link, link, style: "link" })),
    ...topic.documentReferences.map((reference): Content =>
      reference.url
        ? { text: reference.description || reference.url, link: reference.url, style: "link" }
        : { text: reference.description || t("document") },
    ),
  ];
  if (references.length > 0) {
    out.push({ text: t("references"), style: "subTitle" }, { ul: references });
  }

  out.push({ text: `${t("guid")}: ${topic.guid}`, style: "small", margin: [0, 14, 0, 0] });
  return out;
}

/**
 * The first viewpoint across the page, the rest two to a row — the first is
 * usually the one that shows the problem.
 */
function viewpointImages(viewpoints: BcfViewpoint[], images: ReadonlyMap<string, string>, t: ReportTranslate): Content[] {
  const figure = (viewpoint: BcfViewpoint, number: number, width: number, height: number): ContentStack => {
    const image = images.get(viewpoint.guid);
    const caption = `${t("viewpoint", { number })} — ${
      viewpoint.camera || viewpoint.components || viewpoint.clippingPlanes.length > 0
        ? describeViewpoint(viewpoint)
        : t("pictureOnly")
    }`;
    return {
      stack: [
        image
          ? { image, fit: [width, height], alignment: "center" }
          : {
              text: viewpoint.snapshot ? t("snapshotUnreadable") : t("noSnapshot"),
              color: MUTED,
              alignment: "center",
              margin: [0, 18, 0, 18],
            },
        { text: caption, style: "small", margin: [0, 3, 0, 0] },
      ],
      unbreakable: true,
      margin: [0, 0, 0, 10],
    };
  };

  const [first, ...rest] = viewpoints;
  const out: Content[] = [figure(first, 1, CONTENT_WIDTH, 300)];
  const half = (CONTENT_WIDTH - 12) / 2;
  for (let i = 0; i < rest.length; i += 2) {
    const pair = rest.slice(i, i + 2);
    // The row as one piece: unbreakable columns break apart on their own, one
    // picture left at the foot of the page and its neighbour on the next.
    out.push({
      stack: [
        {
          columns: pair.map((viewpoint, j) => ({ width: half, ...figure(viewpoint, i + j + 2, half, 170) })),
          columnGap: 12,
        },
      ],
      unbreakable: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two columns, label and value; rows with no value are left out. */
function keyValueTable(rows: Array<[string, string]>, margin: [number, number, number, number] = [0, 0, 0, 4]): Content {
  const filled = rows.filter(([, value]) => value.trim());
  return {
    table: {
      widths: [95, "*"],
      body: filled.map(([label, value]): TableCell[] => [{ text: label, bold: true, color: "#475569" }, value]),
    },
    layout: "lightHorizontalLines",
    margin,
  };
}

type DateFormatters = { date: (value: string) => string; dateTime: (value: string) => string };

/** BCF dates are ISO 8601; anything else is shown as written rather than as "Invalid Date". */
function dateFormatters(locale: string): DateFormatters {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const format = (formatter: Intl.DateTimeFormat) => (value: string) => {
    // A bare date is a day, not UTC midnight — which is the day before west of Greenwich.
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const parsed = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : formatter.format(parsed);
  };
  return { date: format(date), dateTime: format(dateTime) };
}
