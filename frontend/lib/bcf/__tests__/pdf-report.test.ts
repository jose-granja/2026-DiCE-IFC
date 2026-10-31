// @vitest-environment jsdom

/**
 * The PDF report, built by pdfmake itself: a real `%PDF-` comes out, and the
 * document says what a reader needs — the cover counts, a summary whose rows
 * link to each topic, every viewpoint, the thread with its viewpoint numbers.
 */

import { writeFile } from "node:fs/promises";
import { createTranslator } from "next-intl";
import pdfMake from "pdfmake/build/pdfmake";
import fontFiles from "pdfmake/build/vfs_fonts";
import { describe, expect, it } from "vitest";

import messages from "@/messages/en.json";
import portugueseMessages from "@/messages/pt.json";
import { bcfReportFileName, buildBcfReport, type ReportTranslate } from "../pdf-report";
import { pictureViewpoint } from "../snapshot-file";
import { createComment, createTopic, emptyBcfFile, type BcfFile, type BcfViewpoint } from "../types";

// A 1×1 PNG: what the report is handed after `report-images.ts` has drawn a snapshot.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function translator(locale: "en" | "pt"): ReportTranslate {
  const t = createTranslator({
    locale,
    messages: locale === "en" ? messages : portugueseMessages,
    namespace: "bcf.report",
  });
  return (key, values) => t(key as Parameters<typeof t>[0], values);
}

function sample(): { file: BcfFile; viewpoints: BcfViewpoint[] } {
  const file = emptyBcfFile("coordination.bcf");
  file.project.name = "Hospital Block B";
  const captured: BcfViewpoint = {
    ...pictureViewpoint({ fileName: "a.png", bytes: new Uint8Array([1]) }),
    camera: { kind: "perspective", viewPoint: [0, 0, 0], direction: [0, 1, 0], upVector: [0, 0, 1], fieldOfView: 60 },
  };
  const photo = pictureViewpoint({ fileName: "b.png", bytes: new Uint8Array([2]) });
  const unreadable = pictureViewpoint({ fileName: "c.png", bytes: new Uint8Array([3]) });

  const clash = {
    ...createTopic({ title: "Duct through beam B12", author: "ana@example.com", topicType: "Clash", topicStatus: "Open" }),
    priority: "High",
    assignedTo: "mep@example.com",
    dueDate: "2026-11-05",
    labels: ["MEP", "Structure"],
    description: "The supply duct crosses the beam web at level 2.",
    viewpoints: [captured, photo, unreadable],
    referenceLinks: ["https://example.com/rfi/42"],
  };
  clash.comments = [
    { ...createComment({ author: "rui@example.com", comment: "Moved the duct 300 mm down." }), viewpointGuid: photo.guid },
    createComment({ author: "ana@example.com", comment: "Checked on site." }),
  ];
  const note = createTopic({ title: "Missing door tag", author: "ana@example.com", topicType: "Issue", topicStatus: "Closed" });
  file.topics = [clash, note];
  return { file, viewpoints: [captured, photo, unreadable] };
}

describe("buildBcfReport", () => {
  it("makes a PDF with a cover, linked summary and one page per topic", async () => {
    const { file, viewpoints } = sample();
    const images = new Map([
      [viewpoints[0].guid, PIXEL],
      [viewpoints[1].guid, PIXEL],
    ]);
    const definition = buildBcfReport(
      { file, topics: file.topics, scope: "all", author: "ana@example.com", generatedAt: new Date(), locale: "en", images },
      translator("en"),
    );
    const text = JSON.stringify(definition.content);

    expect(text).toContain("Hospital Block B");
    expect(text).toContain("All 2 topics");
    expect(text).toContain("Topics by status");
    // The summary's rows link to the topics' own pages.
    expect(text).toContain('"linkToDestination":"topic-1"');
    expect(text).toContain('"id":"topic-2"');
    expect(text).toContain("Duct through beam B12");
    expect(text).toContain("Nov 5, 2026");
    expect(text).toContain("MEP, Structure");
    expect(text).toContain("Viewpoints (3)");
    expect(text).toContain("Viewpoint 1 — perspective camera");
    expect(text).toContain("Viewpoint 2 — picture only");
    // A snapshot the browser could not decode costs its picture, not the report.
    expect(text).toContain("The snapshot could not be read.");
    expect(text).toContain("on viewpoint 2");
    expect(text).toContain("https://example.com/rfi/42");
    expect(text.match(/"pageBreak":"before"/g)).toHaveLength(2);

    pdfMake.addVirtualFileSystem(fontFiles);
    const buffer = await pdfMake.createPdf(definition).getBuffer();
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    if (process.env.BCF_PDF_QA_OUTPUT) await writeFile(process.env.BCF_PDF_QA_OUTPUT, buffer);
  }, 60_000);

  it("says which topics it covers, in the reader's language", () => {
    const { file } = sample();
    const definition = buildBcfReport(
      { file, topics: [file.topics[1]], scope: "selected", generatedAt: new Date(), locale: "pt", images: new Map() },
      translator("pt"),
    );
    const text = JSON.stringify(definition.content);
    expect(text).toContain("1 selecionados de 2 tópicos");
    expect(text).toContain("Relatório de tópicos BCF");
    expect(text).toContain("Missing door tag");
    expect(text).not.toContain("Duct through beam B12");
  });

  it("names the file after the project", () => {
    expect(bcfReportFileName(sample().file)).toBe("hospital-block-b-report.pdf");
    expect(bcfReportFileName(emptyBcfFile("Site Walk.bcfzip"))).toBe("site-walk-report.pdf");
  });
});
