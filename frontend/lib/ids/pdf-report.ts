"use client";

import { useTranslations } from "next-intl";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";

import { applicabilityCardinality, type Facet, type IdsDocument } from "./types";
import { useSpecificationLanguage } from "./use-natural-language";

/** Build a text-based PDF entirely from the in-browser IDS document. */
export function useIdsPdfReport() {
  const t = useTranslations("idsCreate.pdf");
  const language = useSpecificationLanguage();

  return (document: IdsDocument): TDocumentDefinitions => {
    const content: Content[] = [
      { text: t("reportTitle"), style: "eyebrow" },
      { text: document.info.title || language.t("notSet"), style: "documentTitle" },
      { text: t("metadataHeading"), style: "sectionTitle" },
    ];

    const metadata = [
      [t("metadata.title"), document.info.title || language.t("notSet")],
      [t("metadata.description"), document.info.description],
      [t("metadata.author"), document.info.author],
      [t("metadata.version"), document.info.version],
      [t("metadata.date"), document.info.date],
      [t("metadata.milestone"), document.info.milestone],
      [t("metadata.purpose"), document.info.purpose],
      [t("metadata.copyright"), document.info.copyright],
    ].filter((row): row is [string, string] => Boolean(row[1]));

    content.push({
      table: {
        widths: [105, "*"],
        body: metadata.map(([label, value]): TableCell[] => [
          { text: label, bold: true, color: "#475569" },
          { text: value },
        ]),
      },
      layout: "lightHorizontalLines",
      margin: [0, 0, 0, 20],
    });

    if (document.specifications.length === 0) {
      content.push({ text: t("noSpecifications"), color: "#64748b" });
    }

    document.specifications.forEach((specification, index) => {
      const applicability = specification.applicability;
      const optionality = applicabilityCardinality(applicability);
      content.push({
        text: t("specification", { number: index + 1, name: specification.name || language.t("unnamed") }),
        style: "specificationTitle",
        ...(index > 0 ? { pageBreak: "before" as const } : {}),
      });

      const details = [
        specification.identifier && `${t("identifier")}: ${specification.identifier}`,
        `${t("ifcSchemas")}: ${language.list.format(specification.ifcVersions) || language.t("notSet")}`,
      ].filter((detail): detail is string => Boolean(detail));
      content.push({ text: details.join("  |  "), style: "smallText" });
      if (specification.description) {
        content.push({ text: specification.description, margin: [0, 7, 0, 0] });
      }
      if (specification.instructions) {
        content.push({ text: `${t("instructions")}: ${specification.instructions}`, style: "smallText" });
      }

      content.push({ text: t("filtersHeading"), style: "sectionTitle" });
      if (optionality) {
        content.push({ text: language.t(`applicability.${optionality}`), margin: [0, 0, 0, 7] });
      } else {
        content.push({
          text: t("customOccurrence", {
            min: String(applicability.minOccurs ?? language.t("notSet")),
            max: String(applicability.maxOccurs ?? language.t("notSet")),
          }),
          margin: [0, 0, 0, 7],
        });
      }

      if (applicability.facets.length) {
        content.push({ text: language.t("allConditions"), style: "smallText" });
        content.push({
          ul: applicability.facets.map(({ facet }) => facetText(facet, language.describeFacet, t("uri"))),
          margin: [0, 4, 0, 10],
        });
      } else {
        content.push({ text: language.t("allEntities"), style: "smallText" });
      }

      content.push({ text: t("requirementsHeading"), style: "sectionTitle" });
      if (optionality === "prohibited") {
        content.push({ text: language.t("requirementsIgnored"), style: "smallText" });
      }
      if (specification.requirements.length === 0) {
        content.push({ text: language.t("noRequirements"), style: "smallText" });
      } else {
        specification.requirements.forEach((requirement, requirementIndex) => {
          content.push({
            text: t("requirement", { number: requirementIndex + 1 }),
            style: "requirementTitle",
          });
          content.push({
            text: language.t(`cardinality.${requirement.cardinality}`, {
              condition: language.describeFacet(requirement.facet),
            }),
            margin: [0, 0, 0, 4],
          });
          const uri = facetUri(requirement.facet);
          if (uri) content.push({ text: `${t("uri")}: ${uri}`, style: "smallText" });
          if (requirement.instructions) {
            content.push({
              text: `${t("instructions")}: ${requirement.instructions}`,
              style: "smallText",
            });
          }
        });
      }
    });

    return {
      info: { title: document.info.title || t("reportTitle"), creator: "DiCE-IFC" },
      pageSize: "A4",
      pageMargins: [46, 54, 46, 54],
      content,
      defaultStyle: { font: "Roboto", fontSize: 10, color: "#0f172a", lineHeight: 1.25 },
      styles: {
        eyebrow: { fontSize: 9, bold: true, color: "#475569", margin: [0, 0, 0, 8] },
        documentTitle: { fontSize: 21, bold: true, color: "#1e3a8a", margin: [0, 0, 0, 18] },
        specificationTitle: { fontSize: 16, bold: true, color: "#1e3a8a", margin: [0, 17, 0, 5] },
        sectionTitle: { fontSize: 12, bold: true, color: "#1e3a8a", margin: [0, 14, 0, 7] },
        requirementTitle: { fontSize: 10, bold: true, margin: [0, 9, 0, 3] },
        smallText: { fontSize: 9, color: "#475569", margin: [0, 3, 0, 4] },
      },
      footer: (page, total) => ({
        text: t("page", { page, total }),
        alignment: "right",
        margin: [0, 0, 46, 0],
        fontSize: 8,
        color: "#64748b",
      }),
    };
  };
}

function facetUri(facet: Facet): string | undefined {
  return "uri" in facet ? facet.uri : undefined;
}

function facetText(
  facet: Facet,
  describeFacet: (facet: Facet) => string,
  uriLabel: string,
): string {
  const uri = facetUri(facet);
  return uri ? `${describeFacet(facet)} (${uriLabel}: ${uri})` : describeFacet(facet);
}
