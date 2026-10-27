/**
 * The clash matrix as an Excel workbook, in the layout of a Solibri-style
 * "Clash Detection Matrix" so one made there can be opened here and back.
 *
 * Sheets: `Clash Detection Matrix` (discipline row, filter row, then one row
 * per group with the tolerance name in each cell below the diagonal),
 * `Tolerances`, `General Requirements`, `Filters` — ours — carrying the
 * full filter of each group, which a single "class" cell cannot hold, and
 * `Models` — also ours — the discipline of each model, by model name.
 */

import {
  buildWorkbook,
  joinListCell,
  namedWorkbookSheets,
  splitListCell,
} from "@/lib/spreadsheets/quantity-workbook";
import { EMPTY_ELEMENT_FILTER, type ElementFilter, type QuantityQueryOperator } from "@/lib/ifc/types";
import { splitTextList } from "@/lib/ifc/text-match";
import { emptyMatrix, newGroup, newTolerance, ruleKey, sanitiseMatrix } from "./matrix";
import { DEFAULT_CLASH_SETTINGS, type ClashGroup, type ClashMatrix } from "./types";

const MATRIX_SHEET = "Clash Detection Matrix";
const TOLERANCES_SHEET = "Tolerances";
const GENERAL_SHEET = "General Requirements";
const FILTERS_SHEET = "Filters";
const MODELS_SHEET = "Models";

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

// One value per line, as the quantity workbook writes them; a hand-typed cell
// may still use commas, which split the way the filter fields in the app do.
const joinList = (values: string[]) => joinListCell(values);
const splitList = (cell: string | undefined) => splitListCell(cell ?? "", splitTextList);

function propertyText(filter: ElementFilter): string {
  return filter.properties
    .map((condition) => {
      const tail = condition.operator === "exists" ? "exists" : `${OPERATOR_TEXT[condition.operator]} ${condition.value}`;
      return `${condition.setName}.${condition.propertyName} ${tail}`;
    })
    .join("\n");
}

/** `Pset.Name = value` lines back into conditions; lines that do not parse are dropped. */
function parseProperties(text: string): ElementFilter["properties"] {
  const operators = Object.entries(OPERATOR_TEXT).sort((a, b) => b[1].length - a[1].length);
  const conditions: ElementFilter["properties"] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const exists = /^(.+?)\.([^.]+?)\s+exists$/i.exec(trimmed);
    if (exists) {
      conditions.push({ setName: exists[1].trim(), propertyName: exists[2].trim(), operator: "exists", value: "" });
      continue;
    }
    for (const [operator, symbol] of operators) {
      if (operator === "exists") continue;
      const at = trimmed.indexOf(` ${symbol} `);
      if (at === -1) continue;
      const path = trimmed.slice(0, at);
      const dot = path.lastIndexOf(".");
      if (dot < 1) continue;
      conditions.push({
        setName: path.slice(0, dot).trim(),
        propertyName: path.slice(dot + 1).trim(),
        operator: operator as QuantityQueryOperator,
        value: trimmed.slice(at + symbol.length + 2).trim(),
      });
      break;
    }
  }
  return conditions;
}

export function createClashWorkbook(matrix: ClashMatrix): Uint8Array {
  const { groups, tolerances, rules } = matrix;
  const toleranceName = new Map(tolerances.map((tolerance) => [tolerance.id, tolerance.name]));
  const groupIndex = new Map(groups.map((group, index) => [group.id, index]));

  // Row 1: discipline per column. Row 2: the group's name per column. Then one
  // row per group; a cell holds the tolerance of the rule, below the diagonal.
  const header1 = ["", "", ...groups.map((group) => group.discipline ?? "")];
  const header2 = ["", "", ...groups.map((group) => group.name)];
  const body = groups.map((row, i) => {
    const cells: string[] = Array(groups.length).fill("");
    for (const rule of rules) {
      const a = groupIndex.get(rule.a);
      const b = groupIndex.get(rule.b);
      if (a === undefined || b === undefined) continue;
      const [low, high] = a <= b ? [a, b] : [b, a];
      if (high === i && low <= i) cells[low] = toleranceName.get(rule.toleranceId) ?? "";
    }
    return [row.discipline ?? "", row.name, ...cells];
  });

  return buildWorkbook([
    {
      name: MATRIX_SHEET,
      rows: [header1, header2, ...body],
      widths: [18, 30, ...groups.map(() => 16)],
    },
    {
      name: TOLERANCES_SHEET,
      rows: [
        // The first five columns are the Solibri layout; Mode and Clearance are ours.
        ["Name", "Horizontal Tolerance", "Vertical Tolerance", "Use Volume Tolerance", "Volume Tolerance", "Mode", "Clearance"],
        ...tolerances.map((tolerance) => [
          tolerance.name,
          tolerance.horizontal,
          tolerance.vertical,
          tolerance.useVolume ? 1 : 0,
          tolerance.volume,
          tolerance.mode === "clearance" ? "Clearance" : "Hard",
          tolerance.clearance,
        ]),
      ],
      widths: [24, 20, 18, 20, 18, 12, 12],
    },
    {
      name: GENERAL_SHEET,
      rows: [
        ["Check Duplicate", matrix.settings.checkDuplicate ? 1 : 0],
        ["Check Inside", matrix.settings.checkInside ? 1 : 0],
        ["Check Overlapping", matrix.settings.checkOverlap ? 1 : 0],
        ["Ignore in the Same Layer and Model", matrix.settings.ignoreSameModel ? 1 : 0],
        // Not in Solibri's sheet; a workbook without the row reads as off.
        ["Ignore in the Same Discipline", matrix.settings.ignoreSameDiscipline ? 1 : 0],
      ],
      widths: [38, 10],
    },
    {
      name: FILTERS_SHEET,
      rows: [
        // Appended, not inserted: the reader below takes columns by position, so
        // a new one in the middle would read an older workbook's properties as
        // its classification.
        ["Group", "Discipline", "Classes", "Names", "Predefined types", "Object types", "Materials", "Material categories", "Properties", "Property rule", "Setup note", "Classification system", "Classification code"],
        ...groups.map((group) => [
          group.name,
          group.discipline ?? "",
          joinList(group.filter.classes),
          joinList(group.filter.names),
          joinList(group.filter.predefinedTypes),
          joinList(group.filter.objectTypes),
          joinList(group.filter.materials),
          joinList(group.filter.materialCategories),
          propertyText(group.filter),
          group.filter.propertyCombination === "any" ? "ANY" : "ALL",
          group.note ?? "",
          group.filter.classificationSystem ?? "",
          joinList(group.filter.classificationCodes ?? []),
        ]),
      ],
      widths: [28, 18, 24, 24, 20, 20, 24, 22, 40, 12, 60, 24, 24],
    },
    {
      name: MODELS_SHEET,
      rows: [
        ["Model", "Discipline"],
        ...Object.entries(matrix.modelDisciplines ?? {}).map(([model, discipline]) => [model, discipline]),
      ],
      widths: [48, 24],
    },
  ]);
}

const truthy = (value: string | undefined) => /^(1|true|yes)$/i.test((value ?? "").trim());
const number = (value: string | undefined, fallback = 0) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Read a workbook made here or in the Solibri layout. */
export function readClashWorkbook(bytes: Uint8Array): ClashMatrix {
  const sheets = namedWorkbookSheets(bytes);
  const sheet = (name: string) =>
    sheets.find((candidate) => candidate.name.trim().toLowerCase() === name.toLowerCase())?.rows;

  const grid = sheet(MATRIX_SHEET) ?? sheets[0]?.rows;
  if (!grid || grid.length < 3) throw new Error("That workbook has no clash matrix sheet.");

  const matrix = emptyMatrix();

  // --- Tolerances ---------------------------------------------------------
  const toleranceRows = sheet(TOLERANCES_SHEET);
  const tolerances = [];
  if (toleranceRows && toleranceRows.length > 1) {
    const headers = (toleranceRows[0] ?? []).map((cell) => (cell ?? "").trim().toLowerCase());
    const column = (name: string) => headers.findIndex((header) => header.includes(name));
    const nameAt = Math.max(0, column("name"));
    const horizontalAt = column("horizontal");
    const verticalAt = column("vertical");
    const modeAt = column("mode");
    const clearanceAt = column("clearance");
    const useVolumeAt = headers.findIndex((header) => header.startsWith("use volume"));
    const volumeAt = headers.findIndex((header) => header === "volume tolerance");
    for (const row of toleranceRows.slice(1)) {
      const name = (row[nameAt] ?? "").trim();
      if (!name) continue;
      tolerances.push(
        newTolerance({
          name,
          mode: /clearance/i.test(row[modeAt] ?? "") ? "clearance" : "hard",
          horizontal: horizontalAt >= 0 ? number(row[horizontalAt], 0) : 0,
          vertical: verticalAt >= 0 ? number(row[verticalAt], 0) : 0,
          clearance: clearanceAt >= 0 ? number(row[clearanceAt], 0.05) : 0.05,
          useVolume: useVolumeAt >= 0 ? truthy(row[useVolumeAt]) : false,
          volume: volumeAt >= 0 ? number(row[volumeAt], 0.01) : 0.01,
        }),
      );
    }
  }
  if (tolerances.length > 0) matrix.tolerances = tolerances;
  const toleranceByName = new Map(matrix.tolerances.map((tolerance) => [tolerance.name.toLowerCase(), tolerance]));

  // --- General requirements ----------------------------------------------
  const general = sheet(GENERAL_SHEET);
  const settings = { ...DEFAULT_CLASH_SETTINGS };
  for (const row of general ?? []) {
    const label = (row[0] ?? "").trim().toLowerCase();
    if (label === "check duplicate") settings.checkDuplicate = truthy(row[1]);
    else if (label === "check inside") settings.checkInside = truthy(row[1]);
    else if (label === "check overlapping") settings.checkOverlap = truthy(row[1]);
    else if (label.startsWith("ignore in the same layer")) settings.ignoreSameModel = truthy(row[1]);
    else if (label.startsWith("ignore in the same discipline")) settings.ignoreSameDiscipline = truthy(row[1]);
  }
  matrix.settings = settings;

  // --- Groups -------------------------------------------------------------
  // Column groups are read from the two header rows; the rows below list the
  // same groups in the same order.
  const columns = Math.max(0, (grid[0]?.length ?? 0) - 2);
  const filterRows = sheet(FILTERS_SHEET);
  const groups: ClashGroup[] = [];

  for (let j = 0; j < columns; j += 1) {
    const discipline = (grid[0]?.[2 + j] ?? "").trim();
    const label = (grid[1]?.[2 + j] ?? "").trim();
    // By position first: the Filters sheet lists the groups in matrix order,
    // and two groups may share a name (a duplicated group starts with its
    // original's), which a lookup by name would give the first one's filter.
    const sameName = (row: string[] | undefined) => (row?.[0] ?? "").trim() === label;
    const fromFilters = sameName(filterRows?.[j + 1])
      ? filterRows![j + 1]
      : filterRows?.slice(1).find(sameName);

    const group = newGroup(label || `Group ${j + 1}`);
    group.discipline = discipline || undefined;
    const note = (fromFilters?.[10] ?? "").trim();
    if (note) group.note = note;
    group.filter = fromFilters
      ? {
          ...EMPTY_ELEMENT_FILTER,
          classes: splitList(fromFilters[2]),
          names: splitList(fromFilters[3]),
          predefinedTypes: splitList(fromFilters[4]),
          objectTypes: splitList(fromFilters[5]),
          materials: splitList(fromFilters[6]),
          materialCategories: splitList(fromFilters[7]),
          classificationSystem: (fromFilters[11] ?? "").trim(),
          classificationCodes: splitList(fromFilters[12]),
          properties: parseProperties(fromFilters[8] ?? ""),
          propertyCombination: /any/i.test(fromFilters[9] ?? "") ? "any" : "all",
        }
      : // A Solibri matrix names each group by its IFC class pattern.
        { ...EMPTY_ELEMENT_FILTER, classes: label ? [label] : [] };
    if (!fromFilters && discipline) group.name = `${discipline} · ${label}`;
    groups.push(group);
  }
  if (groups.length === 0) throw new Error("The matrix sheet has no columns.");
  matrix.groups = groups;

  // --- Cells --------------------------------------------------------------
  const seen = new Set<string>();
  for (let i = 0; i < groups.length; i += 1) {
    const row = grid[2 + i];
    if (!row) continue;
    for (let j = 0; j < groups.length; j += 1) {
      const cell = (row[2 + j] ?? "").trim();
      if (!cell) continue;
      let tolerance = toleranceByName.get(cell.toLowerCase());
      if (!tolerance) {
        // A cell naming a tolerance the Tolerances sheet does not define still
        // means "check this pair"; give it a zero-tolerance hard check.
        tolerance = newTolerance({ name: cell, horizontal: 0, vertical: 0 });
        matrix.tolerances.push(tolerance);
        toleranceByName.set(cell.toLowerCase(), tolerance);
      }
      const key = ruleKey(groups[i].id, groups[j].id);
      if (seen.has(key)) continue;
      seen.add(key);
      matrix.rules.push({ a: groups[i].id, b: groups[j].id, toleranceId: tolerance.id });
    }
  }

  // --- Models -------------------------------------------------------------
  // Absent from a Solibri workbook and from ours before it existed: then no
  // model is classified, and every group picks from every model, as before.
  const modelRows = sheet(MODELS_SHEET);
  const modelDisciplines: Record<string, string> = {};
  for (const row of modelRows?.slice(1) ?? []) {
    const model = (row[0] ?? "").trim();
    const discipline = (row[1] ?? "").trim();
    if (model && discipline) modelDisciplines[model] = discipline;
  }
  matrix.modelDisciplines = modelDisciplines;

  return sanitiseMatrix(matrix);
}
