// @vitest-environment jsdom

import { writeFile } from "node:fs/promises";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import pdfMake from "pdfmake/build/pdfmake";
import fontFiles from "pdfmake/build/vfs_fonts";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { expect, it } from "vitest";

import messages from "@/messages/en.json";
import portugueseMessages from "@/messages/pt.json";
import { useIdsPdfReport } from "../pdf-report";
import { emptyDocument, emptySpecification, simple } from "../types";

it("creates a local PDF from file metadata, filters and natural-language requirements", async () => {
  const document = emptyDocument("Fire safety handover");
  document.info.author = "engineer@example.com";
  document.info.description = "Wall fire rating checks";
  const specification = emptySpecification("Walls carry fire ratings");
  specification.applicability.facets = [
    { id: "f1", facet: { kind: "entity", name: simple("IFCWALL") } },
  ];
  specification.requirements = [
    {
      id: "r1",
      cardinality: "required",
      instructions: "Provide the approved classification.",
      facet: {
        kind: "property",
        propertySet: simple("Pset_WallCommon"),
        baseName: simple("FireRating"),
        value: simple("REI 60"),
      },
    },
  ];
  document.specifications = [specification];

  let definition: TDocumentDefinitions | undefined;
  function CaptureReport() {
    definition = useIdsPdfReport()(document);
    return null;
  }
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CaptureReport />
    </NextIntlClientProvider>,
  );

  expect(definition).toBeDefined();
  pdfMake.addVirtualFileSystem(fontFiles);
  const buffer = await pdfMake.createPdf(definition!).getBuffer();
  expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buffer.length).toBeGreaterThan(1_000);

  if (process.env.IDS_PDF_QA_OUTPUT) {
    await writeFile(process.env.IDS_PDF_QA_OUTPUT, buffer);
  }
}, 60_000);

it("renders Portuguese labels and accented IDS text", async () => {
  const document = emptyDocument("Especificação de incêndio");
  document.info.purpose = "Verificação de segurança";
  const specification = emptySpecification("Proteção contra incêndio");
  specification.applicability.facets = [
    { id: "f1", facet: { kind: "entity", name: simple("IFCWALL") } },
  ];
  specification.requirements = [
    { id: "r1", cardinality: "required", facet: { kind: "material", value: simple("Betão") } },
  ];
  document.specifications = [specification];

  let definition: TDocumentDefinitions | undefined;
  function CaptureReport() {
    definition = useIdsPdfReport()(document);
    return null;
  }
  renderToStaticMarkup(
    <NextIntlClientProvider locale="pt" messages={portugueseMessages}>
      <CaptureReport />
    </NextIntlClientProvider>,
  );

  pdfMake.addVirtualFileSystem(fontFiles);
  const buffer = await pdfMake.createPdf(definition!).getBuffer();
  expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  if (process.env.IDS_PDF_QA_OUTPUT_PT) {
    await writeFile(process.env.IDS_PDF_QA_OUTPUT_PT, buffer);
  }
}, 60_000);
