import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import type {
  PropertyValue,
  QuantityQuery,
  QuantityQueryOperator,
  QuantityQueryRow,
} from "@/lib/ifc/types";

export type QuantityWorkbookDefinition = {
  code: string;
  description: string;
  query: QuantityQuery;
};

export type QuantityWorkbookResult = {
  matchedCount: number;
  missingValueCount: number;
  total: number | null;
  rows: Array<QuantityQueryRow & { modelName: string }>;
};

export type QuantityWorkbookItem = QuantityWorkbookDefinition & {
  result: QuantityWorkbookResult | null;
};

type CellValue = string | number | null | undefined;

const SUMMARY_HEADERS = [
  "Code",
  "Description",
  "IfcClass",
  "Predefined Type",
  "ObjectType",
  "Material",
  "Material Category",
  "Property",
  "Property Rule",
  "Quantity",
  "Formula",
  "Unit",
  "Value",
  "Matched Elements",
  "Missing Values",
] as const;

const DETAIL_HEADERS = [
  "Code",
  "Description",
  "Model",
  "ExpressId",
  "GlobalId",
  "IFC Class",
  "Element Name",
  "Predefined Type",
  "ObjectType",
  "Materials",
  "Source Values",
  "Result",
  "Unit",
] as const;

function meaningful(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^(?:-|—|–|n\/a)$/i.test(text) ? "" : text;
}

function list(value: string): string[] {
  return meaningful(value)
    .split(/(?:\r?\n|\s+\/\s+|;|,)/)
    .map((entry) => meaningful(entry))
    .filter(Boolean);
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const HEADER_ALIASES: Record<string, string[]> = {
  code: ["code", "codigo", "wbs"],
  description: ["description", "descricao"],
  classes: ["ifcclass", "classifc", "classeifc"],
  predefinedTypes: ["predefinedtype", "tipopredefinido"],
  objectTypes: ["objecttype", "tipodeobjeto", "tipoobjeto"],
  materials: ["material", "materials", "materiais"],
  materialCategories: ["materialcategory", "materialcategories", "categoriadomaterial", "categoriamaterial"],
  properties: ["property", "properties", "propriedade", "propriedades"],
  propertyRule: ["propertyrule", "propertycombination", "regradepropriedades", "combinacaodepropriedades"],
  quantities: ["quantity", "quantities", "quantidade", "quantidades"],
  formula: ["formula"],
  unit: ["unit", "unidade"],
};

function findHeader(headers: string[], name: keyof typeof HEADER_ALIASES): number {
  const aliases = new Set(HEADER_ALIASES[name]);
  return headers.findIndex((header) => aliases.has(normalizeHeader(header)));
}

function cell(row: string[], headers: string[], name: keyof typeof HEADER_ALIASES) {
  const index = findHeader(headers, name);
  return index < 0 ? "" : meaningful(row[index]);
}

const OPERATOR_TEXT: Record<QuantityQueryOperator, string> = {
  equals: "=",
  notEquals: "!=",
  contains: "contains",
  greaterThan: ">",
  greaterOrEqual: ">=",
  lessThan: "<",
  lessOrEqual: "<=",
  exists: "exists",
};

function parseProperties(value: string): QuantityQuery["filters"]["properties"] {
  const properties: QuantityQuery["filters"]["properties"] = [];
  for (const line of meaningful(value).split(/\r?\n|;/).map((entry) => entry.trim())) {
    if (!meaningful(line)) continue;
    const expression = line.match(/^(.+?)(?:\s+(contains|exists)\s*|\s*(>=|<=|!=|<>|=|>|<)\s*)(.*)$/i);
    if (!expression) continue;
    const path = meaningful(expression[1]);
    const split = path.lastIndexOf(".");
    if (split <= 0 || split === path.length - 1) continue;
    const rawOperator = (expression[2] || expression[3] || "=").toLocaleLowerCase();
    const operator: QuantityQueryOperator =
      rawOperator === "contains" ? "contains" :
      rawOperator === "exists" ? "exists" :
      rawOperator === "!=" || rawOperator === "<>" ? "notEquals" :
      rawOperator === ">" ? "greaterThan" :
      rawOperator === ">=" ? "greaterOrEqual" :
      rawOperator === "<" ? "lessThan" :
      rawOperator === "<=" ? "lessOrEqual" : "equals";
    properties.push({
      setName: path.slice(0, split).trim(),
      propertyName: path.slice(split + 1).trim(),
      operator,
      value: operator === "exists" ? "" : meaningful(expression[4]),
    });
  }
  return properties;
}

function aliasFromPath(path: string, fallback: string) {
  const candidate = path.split(".").at(-1)?.replace(/[^A-Za-z0-9_]/g, "_") ?? "";
  const prefixed = /^[A-Za-z_]/.test(candidate) ? candidate : `value_${candidate}`;
  return prefixed || fallback;
}

function parseSources(value: string) {
  const sources: QuantityQuery["sources"] = [];
  const aliases = new Set<string>();
  for (const [index, rawLine] of meaningful(value).split(/\r?\n|;/).entries()) {
    const line = meaningful(rawLine);
    if (!line) continue;
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    const explicitAlias = assignment?.[1];
    let path = meaningful(assignment?.[2] ?? line);
    if (/^\(?\s*(?:element\s+count|count|contagem(?:\s+de\s+elementos)?)\s*\)?$/i.test(path)) {
      let alias = explicitAlias ?? "count";
      while (aliases.has(alias)) alias = `${alias}_${index + 1}`;
      aliases.add(alias);
      sources.push({ id: `source-${index + 1}`, alias, kind: "count" });
      continue;
    }

    let kind: "property" | "quantity" = "quantity";
    if (/^property\s*:/i.test(path)) {
      kind = "property";
      path = path.replace(/^property\s*:/i, "").trim();
    } else if (/^quantity\s*:/i.test(path)) {
      path = path.replace(/^quantity\s*:/i, "").trim();
    } else if (/^Pset_/i.test(path)) {
      kind = "property";
    }
    const split = path.lastIndexOf(".");
    if (split <= 0 || split === path.length - 1) continue;
    let alias = explicitAlias ?? aliasFromPath(path, `value${index + 1}`);
    while (aliases.has(alias)) alias = `${alias}_${index + 1}`;
    aliases.add(alias);
    sources.push({
      id: `source-${index + 1}`,
      alias,
      kind,
      setName: path.slice(0, split).trim(),
      valueName: path.slice(split + 1).trim(),
    });
  }
  return sources;
}

/** Convert rows using the same columns as the user's WBS reference table. */
export function parseQuantityConfigurationRows(rows: string[][]): QuantityWorkbookDefinition[] {
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map(normalizeHeader);
    return findHeader(normalized, "description") >= 0 && findHeader(normalized, "quantities") >= 0;
  });
  if (headerIndex < 0) {
    throw new Error("The workbook has no table with Description and Quantity columns.");
  }

  const headers = rows[headerIndex];
  const definitions: QuantityWorkbookDefinition[] = [];
  for (const [rowOffset, row] of rows.slice(headerIndex + 1).entries()) {
    const quantityText = cell(row, headers, "quantities");
    const sources = parseSources(quantityText);
    // Chapter headings and unmapped rows from the reference table have no
    // measurable source. Keeping them would accidentally count every model
    // element when the list is executed.
    if (sources.length === 0) continue;
    const explicitFormula = cell(row, headers, "formula").replace(/^=/, "").trim();
    const formula = explicitFormula ||
      (sources.length > 1 ? sources.map((source) => source.alias).join(" + ") : undefined);
    const properties = parseProperties(cell(row, headers, "properties"));
    const rule = normalizeHeader(cell(row, headers, "propertyRule"));
    definitions.push({
      code: cell(row, headers, "code"),
      description: cell(row, headers, "description") || `Quantity ${rowOffset + 1}`,
      query: {
        filters: {
          classes: list(cell(row, headers, "classes")),
          predefinedTypes: list(cell(row, headers, "predefinedTypes")),
          objectTypes: list(cell(row, headers, "objectTypes")),
          materials: list(cell(row, headers, "materials")),
          materialCategories: list(cell(row, headers, "materialCategories")),
          propertyCombination:
            rule === "all" || rule === "and" || rule === "todas" || rule === "e"
              ? "all"
              : rule === "any" || rule === "or" || rule === "qualquer" || rule === "ou"
                ? "any"
                : properties.length > 1 ? "any" : "all",
          properties,
        },
        sources,
        formula,
        unit: cell(row, headers, "unit") || undefined,
      },
    });
  }
  if (definitions.length === 0) {
    throw new Error("The workbook contains no rows with a usable Quantity value.");
  }
  return definitions;
}

function xml(source: Uint8Array) {
  const document = new DOMParser().parseFromString(strFromU8(source), "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The Excel workbook contains invalid XML.");
  }
  return document;
}

export function workbookSheets(bytes: Uint8Array): string[][][] {
  return namedWorkbookSheets(bytes).map((sheet) => sheet.rows);
}

/** Every sheet of an .xlsx with its name, as rows of text (formulas as `=…`). */
export function namedWorkbookSheets(bytes: Uint8Array): Array<{ name: string; rows: string[][] }> {
  const files = unzipSync(bytes);
  const workbookFile = files["xl/workbook.xml"];
  const relationshipsFile = files["xl/_rels/workbook.xml.rels"];
  if (!workbookFile || !relationshipsFile) throw new Error("That file is not a valid .xlsx workbook.");
  const workbook = xml(workbookFile);
  const relationships = xml(relationshipsFile);
  const sharedFile = files["xl/sharedStrings.xml"];
  const shared = sharedFile
    ? [...xml(sharedFile).getElementsByTagNameNS("*", "si")]
        .map((entry) => [...entry.getElementsByTagNameNS("*", "t")].map((part) => part.textContent ?? "").join(""))
    : [];
  const relationById = new Map(
    [...relationships.getElementsByTagNameNS("*", "Relationship")]
      .map((entry) => [entry.getAttribute("Id"), entry.getAttribute("Target")] as const),
  );
  const sheets: Array<{ name: string; rows: string[][] }> = [];
  for (const sheetEntry of workbook.getElementsByTagNameNS("*", "sheet")) {
    const relationshipId = sheetEntry.getAttribute("r:id") ??
      sheetEntry.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relationById.get(relationshipId)?.replace(/^\//, "");
    if (!target) continue;
    const sheetPath = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
    const sheetFile = files[sheetPath];
    if (!sheetFile) continue;
    const sheet = xml(sheetFile);
    const rows: string[][] = [];
    for (const row of sheet.getElementsByTagNameNS("*", "row")) {
      const values: string[] = [];
      for (const cell of row.getElementsByTagNameNS("*", "c")) {
        const reference = cell.getAttribute("r") ?? "A1";
        const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
        let column = 0;
        for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
        column -= 1;
        const type = cell.getAttribute("t");
        const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
        const formula = cell.getElementsByTagNameNS("*", "f")[0]?.textContent;
        let value = raw;
        if (formula) value = `=${formula}`;
        else if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") {
          value = [...cell.getElementsByTagNameNS("*", "t")].map((part) => part.textContent ?? "").join("");
        } else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        values[column] = value;
      }
      rows.push(values);
    }
    sheets.push({ name: sheetEntry.getAttribute("name") ?? `Sheet${sheets.length + 1}`, rows });
  }
  if (sheets.length === 0) throw new Error("The Excel workbook contains no readable worksheet.");
  return sheets;
}

export function readQuantityWorkbook(bytes: Uint8Array): QuantityWorkbookDefinition[] {
  const definitions: QuantityWorkbookDefinition[] = [];
  for (const rows of workbookSheets(bytes)) {
    try {
      definitions.push(...parseQuantityConfigurationRows(rows));
    } catch {
      // Cover, instructions and exported element-detail sheets are not
      // configuration tables. Continue until a compatible table is found.
    }
  }
  if (definitions.length === 0) {
    throw new Error("The workbook contains no table with usable Description and Quantity columns.");
  }
  return definitions;
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function worksheet(rows: CellValue[][], widths: number[]) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${reference}" s="${rowIndex === 0 ? 1 : 2}"><v>${value}</v></c>`;
      }
      return `<c r="${reference}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ""}>${cells}</row>`;
  }).join("");
  const columns = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join("");
  const last = `${columnName(Math.max(0, rows[0].length - 1))}${Math.max(1, rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columns}</cols><sheetData>${body}</sheetData><autoFilter ref="A1:${columnName(rows[0].length - 1)}${rows.length}"/>
</worksheet>`;
}

function propertyText(query: QuantityQuery) {
  return query.filters.properties.map((condition) => {
    const suffix = condition.operator === "exists" ? "exists" :
      `${OPERATOR_TEXT[condition.operator]} ${condition.value}`;
    return `${condition.setName}.${condition.propertyName} ${suffix}`;
  }).join("\n");
}

function quantityText(query: QuantityQuery) {
  const includeAliases = query.sources.length > 1;
  return query.sources.map((source) => {
    if (source.kind === "count") return includeAliases ? `${source.alias} = (element count)` : "(element count)";
    const prefix = source.kind === "property" ? "property:" : "";
    const path = `${prefix}${source.setName}.${source.valueName}`;
    return includeAliases ? `${source.alias} = ${path}` : path;
  }).join("\n");
}

function sourceValues(inputs: Record<string, PropertyValue>) {
  return Object.entries(inputs).map(([name, value]) => `${name}=${String(value ?? "")}`).join("; ");
}

export type WorkbookSheet = { name: string; rows: CellValue[][]; widths: number[] };

/** A workbook of plain sheets: a styled header row, inline strings and numbers. */
export function buildWorkbook(sheets: WorkbookSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets
  .map(
    (_, index) =>
      `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("")}</sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, index) =>
      `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  .join("\n")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF243B64"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`),
    ...Object.fromEntries(
      sheets.map((sheet, index) => [
        `xl/worksheets/sheet${index + 1}.xml`,
        strToU8(worksheet(sheet.rows, sheet.widths)),
      ]),
    ),
  };
  return zipSync(files, { level: 6 });
}

export function createQuantityWorkbook(items: QuantityWorkbookItem[]): Uint8Array {
  const summaryRows: CellValue[][] = [Array.from(SUMMARY_HEADERS)];
  const detailRows: CellValue[][] = [Array.from(DETAIL_HEADERS)];
  for (const item of items) {
    summaryRows.push([
      item.code,
      item.description,
      item.query.filters.classes.join("\n"),
      item.query.filters.predefinedTypes.join("\n"),
      item.query.filters.objectTypes.join("\n"),
      item.query.filters.materials.join("\n"),
      (item.query.filters.materialCategories ?? []).join("\n"),
      propertyText(item.query),
      item.query.filters.propertyCombination === "any" ? "ANY" : "ALL",
      quantityText(item.query),
      item.query.formula ?? "",
      item.query.unit ?? "",
      item.result?.total,
      item.result?.matchedCount,
      item.result?.missingValueCount,
    ]);
    for (const row of item.result?.rows ?? []) {
      detailRows.push([
        item.code,
        item.description,
        row.modelName,
        row.expressId,
        row.globalId,
        row.type,
        row.name,
        row.predefinedType,
        row.objectType,
        row.materials.join("; "),
        sourceValues(row.inputs),
        typeof row.value === "number" ? row.value : String(row.value ?? ""),
        item.query.unit ?? "",
      ]);
    }
  }

  return buildWorkbook([
    { name: "Quantities", rows: summaryRows, widths: [14, 34, 18, 18, 24, 18, 18, 36, 14, 36, 22, 10, 14, 16, 14] },
    { name: "Elements", rows: detailRows, widths: [14, 34, 24, 12, 24, 18, 28, 18, 22, 24, 34, 14, 10] },
  ]);
}
