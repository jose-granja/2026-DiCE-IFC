import { namedWorkbookSheets, parseQuantityConfigurationRows } from "./quantity-workbook";

/** The workbook is the source of truth for both the queries and their labels. */
export const DEFAULT_QUANTITY_TEMPLATE_URL = "/templates/mqt-default.xlsx";

export function readDefaultQuantityTemplate(bytes: Uint8Array, locale: string) {
  const sheet = namedWorkbookSheets(bytes).find((entry) => entry.name === "Quantities");
  if (!sheet) throw new Error("Missing Quantities worksheet.");
  const headerIndex = sheet.rows.findIndex((row) => row.includes("Code") && row.includes("Quantity"));
  if (headerIndex < 0) throw new Error("Missing quantity template headers.");
  const rows = sheet.rows.slice(headerIndex).map((row) => [...row]);
  const descriptionIndex = rows[0].indexOf("Description");
  const translatedIndex = rows[0].indexOf("Description (PT)");
  if (locale.startsWith("pt") && descriptionIndex >= 0 && translatedIndex >= 0) {
    for (const row of rows.slice(1)) if (row[translatedIndex]?.trim()) row[descriptionIndex] = row[translatedIndex];
  }
  return parseQuantityConfigurationRows(rows).map((definition) => ({
    ...definition,
    // Stable IDs preserve edits and prevent repeated clicks from adding copies.
    id: `mqt-default:${definition.code}`,
  }));
}
