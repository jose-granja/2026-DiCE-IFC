import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { createQuantityWorkbook, readQuantityWorkbook } from "../lib/spreadsheets/quantity-workbook";

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

test("adds missing extracted values as zero in quantity formulas", async ({ page }) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "missing-values.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([{
      code: "ZERO.01", description: "Missing-value addition", result: null,
      query: {
        filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
        sources: [
          { id: "area", alias: "area", kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" },
          { id: "extra", alias: "extra", kind: "property", setName: "Pset_WallCommon", valueName: "MissingProperty" },
          { id: "extra_area", alias: "extra_area", kind: "quantity", setName: "MissingQuantitySet", valueName: "Area" },
        ],
        formula: "area + extra + extra_area", unit: "m²",
      },
    }])),
  });
  await expect(page.locator('[data-query-list] [role="listitem"]')).toContainText("Missing-value addition");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  const results = page.locator("[data-query-results]");
  await expect(results).toContainText("2 matched · 2 values · 0 missing");
  await expect(results.getByText("25 m²", { exact: true })).toBeVisible();
  await expect(results.getByRole("cell", { name: "12.5 m²", exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "Edit Missing-value addition", exact: true }).click();
  await page.getByRole("tab", { name: "Values", exact: true }).click();
  await expect(page.getByText(/Missing or empty values count as 0 in formulas/)).toBeVisible();
  await page.getByLabel("Formula", { exact: true }).fill("extra + extra_area");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(results).toContainText("2 matched · 2 values · 0 missing");
  await expect(results.getByText("0 m²", { exact: true }).first()).toBeVisible();
  await expect(results.getByRole("cell", { name: "0 m²", exact: true })).toHaveCount(2);
});

test("loads the bundled MQT template, preserves existing queries and runs real quantities", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "custom.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([{
      code: "MY.01", description: "My existing query", result: null,
      query: { filters: { classes: ["IfcSlab"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] }, sources: [{ id: "count", alias: "count", kind: "count" }], unit: "un" },
    }])),
  });
  const items = page.locator('[data-query-list] [role="listitem"]');
  await expect(items).toHaveCount(1);
  await page.getByRole("button", { name: "Use default template", exact: true }).click();
  await expect(items).toHaveCount(13);
  await expect(items.first()).toContainText("My existing query");
  await expect(items.filter({ hasText: "Walls: net side area" })).toContainText("MQT.01");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByText("25 m²", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Use default template", exact: true }).click();
  await expect(page.getByText("The default template is already in your list.")).toBeVisible();
  await expect(items).toHaveCount(13);
  await page.getByRole("button", { name: "Edit Walls: net side area", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("My wall measurement");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.locator('[role="tab"][id$="-trigger-classes"]').click();
  await page.locator('[role="tab"][id$="-trigger-quantities"]').click();
  await page.getByRole("button", { name: "Use default template", exact: true }).click();
  await expect(items).toHaveCount(13);
  await expect(items.filter({ hasText: "MQT.01" })).toContainText("My wall measurement");
  await page.screenshot({ path: testInfo.outputPath("mqt-default-template.png") });
  expect(errors).toEqual([]);
});

test("recovers from an unavailable template and loads its Portuguese descriptions", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "dice-locale", value: "pt", url: baseURL! }]);
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.route("**/templates/mqt-default.xlsx", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  const useTemplate = page.getByRole("button", { name: "Usar template padrão", exact: true });
  await useTemplate.click();
  await expect(page.getByText("Não foi possível carregar o template padrão. Tente novamente.")).toBeVisible();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(0);
  await expect(useTemplate).toBeEnabled();
  await page.unroute("**/templates/mqt-default.xlsx");
  await useTemplate.click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(12);
  await expect(page.locator('[data-query-list] [role="listitem"]').first()).toContainText("Paredes: área lateral líquida");
});

test("builds a table-style quantity query and applies its results to the viewer", async ({
  page,
}) => {
  // The longest test here — a model, two runs, a download and an isolation —
  // and past the default 30 s budget when the whole file runs in parallel.
  test.setTimeout(60_000);
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("button", { name: "New" }).click();
  const filters = page.locator("[data-query-filters]");
  await filters.getByLabel("IFC class").fill("IfcWall");
  await filters.getByLabel("Material", { exact: true }).fill("Concrete C30/37");
  await filters.getByRole("button", { name: "Add" }).click();
  await filters.getByLabel("Set").fill("Pset_WallCommon");
  await filters.getByLabel("Property", { exact: true }).fill("LoadBearing");
  await filters.getByLabel("Value", { exact: true }).fill("TRUE");

  await page.getByRole("tab", { name: "Values" }).click();
  await expect(filters).not.toBeVisible();
  const sources = page.locator("[data-query-sources]");
  await expect(sources).toBeVisible();
  await sources.getByLabel("Set").fill("Qto_WallBaseQuantities");
  await sources.getByLabel("Quantity", { exact: true }).fill("NetSideArea");
  await sources.getByLabel("Result unit").fill("m²");

  await page.getByLabel("Code").fill("13.01.01");
  await page.getByLabel("Description").fill("Concrete walls");

  await page.getByRole("button", { name: "Add to list" }).click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toContainText("13.01.01");
  await expect(page.locator('[data-query-list] [role="listitem"]')).toContainText("Concrete walls");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByRole("tab", { name: "Results" })).toHaveAttribute("data-state", "active");
  await expect(page.getByText("2 matched · 2 values · 0 missing")).toBeVisible();
  await expect(page.getByText("25 m²", { exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Duplicate Concrete walls" }).click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(2);
  await expect(page.locator("[data-query-metadata-editor]")).toBeVisible();
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(page.locator('[data-query-list] [role="listitem"]', { hasText: "25 m²" })).toHaveCount(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("ifc-quantities.xlsx");

  await page.locator("[data-quantity-query-panel]").getByRole("button", {
    name: "Isolate",
    exact: true,
  }).click();
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute(
    "data-visible-entities",
    "2/3",
  );

  // The list row truncates; its whole code and description show on hover.
  await expect(page.locator('[data-query-list] [role="listitem"] button').first()).toHaveAttribute(
    "title",
    "13.01.01 · Concrete walls",
  );

  // A result row puts that element in focus: the whole result isolated, the
  // element solid and selected, the other result see-through.
  const scene = page.locator("[data-rendered-models]");
  await page.locator('[data-query-list] [role="listitem"] button').first().click();
  await page.getByRole("tab", { name: "Results" }).click();
  const rows = page.locator("[data-query-result-row]");
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute("aria-current", "true");
  await expect(scene).toHaveAttribute("data-visible-entities", "2/3");
  await expect(scene).toHaveAttribute("data-translucent-entities", "1");
  // Selected, so its properties are what the properties panel shows.
  const rowName = (await rows.first().locator("td").first().getAttribute("title"))!.split(" · ").pop()!;
  await expect(page.locator("[data-property-panel]").getByRole("heading", { name: rowName, exact: true })).toBeVisible();

  // Another row moves the focus; the same row again shows everything.
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.first()).not.toHaveAttribute("aria-current", "true");
  await expect(scene).toHaveAttribute("data-translucent-entities", "1");
  await rows.nth(1).click();
  await expect(scene).toHaveAttribute("data-visible-entities", "3/3");
  await expect(scene).toHaveAttribute("data-translucent-entities", "0");

  // Definitions stay available when the panel unmounts while another viewer
  // tab is open; only model-derived result rows are recalculated.
  // By id, not by name: the viewer's own class-filter tab and this panel's
  // filter tab are both called "Filters".
  await page.locator('[role="tab"][id$="-trigger-classes"]').click();
  // By name here: with an element selected, the properties panel has a
  // "Quantities" tab with the same id suffix.
  await page.getByRole("tab", { name: "QTO", exact: true }).click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(2);
});

test("imports an Excel quantity table and runs its configuration", async ({ page }) => {
  const workbook = createQuantityWorkbook([{
    code: "13.01.01",
    description: "Imported wall area",
    query: {
      filters: {
        classes: ["IfcWall"],
        predefinedTypes: [],
        objectTypes: [],
        materials: ["Concrete C30/37"],
        properties: [{
          setName: "Pset_WallCommon",
          propertyName: "LoadBearing",
          operator: "equals",
          value: "TRUE",
        }],
      },
      sources: [{
        id: "area",
        alias: "area",
        kind: "quantity",
        setName: "Qto_WallBaseQuantities",
        valueName: "NetSideArea",
      }],
      unit: "m²",
    },
    result: null,
  }]);

  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "quantities.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbook),
  });

  const item = page.locator('[data-query-list] [role="listitem"]', {
    hasText: "Imported wall area",
  });
  await expect(item).toContainText("13.01.01");
  await expect(page.locator("[data-query-metadata-view]")).toBeVisible();
  await expect(page.getByLabel("IFC class")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit Imported wall area" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Imported wall area" })).toBeVisible();
  await page.getByRole("button", { name: "Edit Imported wall area" }).click();
  await expect(page.locator("[data-query-metadata-editor]")).toBeVisible();
  await expect(page.getByLabel("IFC class")).toBeEnabled();
  await page.getByRole("button", { name: "View Imported wall area" }).click();
  await expect(page.locator("[data-query-metadata-view]")).toBeVisible();
  await expect(page.getByLabel("IFC class")).toBeDisabled();
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText("25 m²", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Delete Imported wall area" }).click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(0);
});

/**
 * Filtering a quantity by classification: the way a bill of quantities is
 * actually indexed. `classified-wall-ifc4.ifc` puts Wall A in two systems at
 * once, so the panel can be shown to ask for a code *within* a system rather
 * than for the two independently.
 */
test("filters a quantity by classification code within a system", async ({ page }) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', [
    path.resolve(__dirname, "../fixtures/ifc/classified-wall-ifc4.ifc"),
  ]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await page.getByRole("button", { name: "New" }).click();
  const filters = page.locator("[data-query-filters]");
  const system = filters.getByLabel("Classification system");
  const code = filters.getByLabel("Classification code");

  // The systems the model declares are offered, and the codes follow the system.
  const options = async (field: typeof system) =>
    field.evaluate((input: HTMLInputElement) =>
      [...(document.getElementById(input.getAttribute("list")!) as HTMLDataListElement).options].map(
        (option) => option.value,
      ),
    );
  await expect
    .poll(async () => options(system), { timeout: 30_000 })
    .toEqual(["Sistema Nacional", "Uniclass 2015"]);

  await system.fill("Uniclass 2015");
  await expect.poll(async () => options(code)).toEqual([
    "Ss_25_10_30",
    "Ss_25_10_60",
    "Ss_30_10_30",
  ]);

  // A whole branch of the hierarchy: the two walls, not the slab.
  await code.fill("Ss_25*");
  await page.getByRole("tab", { name: "Values" }).click();
  await page.locator("[data-query-sources]").getByRole("combobox", { name: "Source kind" }).click();
  await page.getByRole("option", { name: "Element count" }).click();
  await page.getByLabel("Code").fill("13.01");
  await page.getByLabel("Description").fill("Classified walls");
  await page.getByRole("button", { name: "Add to list" }).click();
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText("2 matched · 2 values · 0 missing")).toBeVisible({ timeout: 30_000 });

  // The same code asked for in the other system matches nothing: Wall A is in
  // both systems, but Ss_25_10_30 belongs to only one of them.
  await page.getByRole("button", { name: /^Edit Classified walls/ }).click();
  await page.locator("[data-quantity-query-panel]").getByRole("tab", { name: "Filters" }).click();
  await filters.getByLabel("Classification system").fill("Sistema Nacional");
  await filters.getByLabel("Classification code").fill("Ss_25_10_30");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText("0 matched · 0 values · 0 missing")).toBeVisible({ timeout: 30_000 });
});

test("rounds its numbers to the viewer's decimal places setting, for display only", async ({ page }) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  // Each wall's 12.5 m² over three: 4.1666… per wall, 8.333… in all.
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "thirds.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([{
      code: "THIRD.01", description: "A third of each wall", result: null,
      query: {
        filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
        sources: [
          { id: "area", alias: "area", kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" },
        ],
        formula: "area / 3", unit: "m²",
      },
    }])),
  });
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  const results = page.locator("[data-query-results]");
  const listItem = page.locator('[data-query-list] [role="listitem"]');

  // The default, three places.
  await expect(results.getByText("8.333 m²", { exact: true })).toBeVisible();
  await expect(results.getByRole("cell", { name: "4.167 m²", exact: true })).toHaveCount(2);
  await expect(listItem).toContainText("8.333 m²");

  await page.getByRole("button", { name: "Open display settings" }).click();
  await page.getByRole("combobox", { name: "Decimal places" }).selectOption("1");
  await page.keyboard.press("Escape");
  await expect(results.getByText("8.3 m²", { exact: true })).toBeVisible();
  await expect(results.getByRole("cell", { name: "4.2 m²", exact: true })).toHaveCount(2);
  await expect(listItem).toContainText("8.3 m²");

  // The CSV keeps every digit: rounding is how the panel shows a value, not the value.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download this query's rows as CSV" }).click();
  const csv = await (await (await downloading).createReadStream()).toArray();
  expect(Buffer.concat(csv).toString("utf8")).toContain("4.166666666666667");
});

test("opens the whole list in a window, with the selected line to see, edit and run beside it", async ({
  page,
}, testInfo) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  const longDescription =
    "Load-bearing concrete walls of the ground floor, measured on their net side area without openings";
  const area = { id: "area", alias: "area", kind: "quantity", setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" } as const;
  const walls = { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] };
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "list.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([
      { code: "13.01", description: longDescription, result: null, query: { filters: walls, sources: [area], unit: "m²" } },
      { code: "13.02", description: "Slabs", result: null,
        query: { filters: { ...walls, classes: ["IfcSlab"] }, sources: [{ id: "n", alias: "count", kind: "count" }] } },
      { code: "21.01", description: "Wall count", result: null,
        query: { filters: walls, sources: [{ id: "n", alias: "count", kind: "count" }] } },
    ])),
  });
  await expect(page.locator('[data-query-list] [role="listitem"]')).toHaveCount(3);

  await page.locator("[data-query-list-expand]").click();
  const dialog = page.locator("[data-query-list-dialog]");
  const items = dialog.locator("[data-query-list-dialog-items] [role='listitem']");
  const side = dialog.locator("[data-query-list-dialog-editor]");
  await expect(items).toHaveCount(3);
  // In full, not cut to the width of a side panel.
  const full = items.first().getByText(longDescription, { exact: true });
  await expect(full).toBeVisible();
  expect(await full.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // The line the panel had selected (an import selects its first) is beside the list.
  await expect(side.locator("[data-query-metadata-view]")).toContainText("13.01");

  await dialog.getByLabel("Search code or description").fill("21.");
  await expect(items).toHaveCount(1);
  await expect(dialog.getByText("1 of 3")).toBeVisible();
  await dialog.getByLabel("Search code or description").fill("");

  // Picking a line shows it beside the list; running it there gives its results.
  await items.filter({ hasText: "Wall count" }).getByRole("button", { name: /^View/ }).click();
  await expect(side.locator("[data-query-metadata-view]")).toContainText("Wall count");
  await side.getByRole("button", { name: "Run query" }).click();
  await expect(side.locator("[data-query-results]")).toContainText("2 matched");
  await expect(items.filter({ hasText: "Wall count" })).toContainText("2");
  await dialog.screenshot({ path: testInfo.outputPath("list-dialog.png") });

  // Editing there changes the list.
  await items.filter({ hasText: "Slabs" }).getByRole("button", { name: "Edit Slabs" }).click();
  await side.getByLabel("Description").fill("Floor slabs");
  await side.getByRole("button", { name: "Update" }).click();
  await expect(items.filter({ hasText: "Floor slabs" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Floor slabs" })).toHaveAttribute("aria-current", "true");

  // Closed, the panel carries on with the same line.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-query-list] [role="listitem"]', { hasText: "Floor slabs" }))
    .toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-query-metadata-view]")).toContainText("Floor slabs");
  await expect(page.getByRole("tab", { name: "Filters", exact: true }).last()).toBeVisible();
});

test("shows the list as a hierarchy that folds, with grouping lines that are headings and never run", async ({
  page,
}, testInfo) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  const none = { classes: [], predefinedTypes: [], objectTypes: [], materials: [], properties: [] };
  const walls = { ...none, classes: ["IfcWall"] };
  const count = [{ id: "n", alias: "count", kind: "count" as const }];
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "chapters.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([
      { level: 1, code: "13", description: "ALVENARIAS", result: null, query: { filters: none, sources: [] } },
      { level: 2, code: "13.01", description: "Paredes", result: null, query: { filters: none, sources: [] } },
      { level: 3, code: "13.01.01", description: "Wall count", result: null, query: { filters: walls, sources: count } },
      { level: 1, code: "14", description: "Slab count", result: null,
        query: { filters: { ...none, classes: ["IfcSlab"] }, sources: count } },
    ])),
  });
  const list = page.locator('[data-query-list] [role="listitem"]');
  await expect(list).toHaveCount(4);
  await expect(list.nth(0)).toHaveAttribute("data-query-group", "true");
  await expect(list.nth(2)).toHaveAttribute("data-query-level", "3");
  // Indented by level.
  const left = async (index: number) => (await list.nth(index).getByRole("button", { name: /^View/ }).boundingBox())!.x;
  expect(await left(2)).toBeGreaterThan(await left(1));
  expect(await left(1)).toBeGreaterThan(await left(0));

  // Folding a chapter hides its branch and says how much is in it.
  await page.getByRole("button", { name: "Hide the lines under ALVENARIAS" }).click();
  await expect(list).toHaveCount(2);
  await expect(list.nth(0)).toContainText("2 lines");
  await page.getByRole("button", { name: "Show the lines under ALVENARIAS" }).click();
  await expect(list).toHaveCount(4);
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(list).toHaveCount(2);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(list).toHaveCount(4);

  // Run all measures the lines and leaves the headings alone.
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(list.nth(2)).toContainText("2");
  await expect(list.nth(3)).toContainText("1");
  await expect(list.nth(0)).not.toContainText("Not run");

  // A grouping line opens onto the elements of the lines under it, with nothing of its own to run.
  await list.nth(1).getByRole("button", { name: /^View/ }).click();
  const group = page.locator("[data-query-group-elements]");
  await expect(group).toContainText("2 elements from 1 line under this heading");
  await expect(group.locator("[data-query-group-element]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Run query" })).toHaveCount(0);

  // New, with a heading selected, adds a line under it: after its branch, one level down.
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await expect(page.getByLabel("Level")).toHaveValue("3");
  await page.getByLabel("Description").fill("Wall area");
  await page.locator("[data-query-filters]").getByLabel("IFC class").fill("IfcWall");
  await page.getByRole("tab", { name: "Values" }).click();
  await page.locator("[data-query-sources]").getByLabel("Set").fill("Qto_WallBaseQuantities");
  await page.locator("[data-query-sources]").getByLabel("Quantity", { exact: true }).fill("NetSideArea");
  await page.getByRole("button", { name: "Add to list" }).click();
  await expect(list).toHaveCount(5);
  await expect(list.nth(3)).toContainText("Wall area");
  await expect(list.nth(3)).toHaveAttribute("data-query-level", "3");

  // A line becomes a heading by ticking "Grouping line".
  await list.nth(4).getByRole("button", { name: "Edit Slab count" }).click();
  await page.locator("[data-query-group-toggle]").check();
  await page.getByLabel("Level").fill("2");
  await page.getByRole("button", { name: "Update" }).click();
  await expect(list.nth(4)).toHaveAttribute("data-query-group", "true");
  await expect(list.nth(4)).toHaveAttribute("data-query-level", "2");

  // The window has a level column of its own.
  await page.locator("[data-query-list-expand]").click();
  const items = page.locator("[data-query-list-dialog-items] [role='listitem']");
  await expect(items.locator("[data-query-level-cell]")).toHaveText(["1", "2", "3", "3", "2"]);
  await page.locator("[data-query-list-dialog]").screenshot({ path: testInfo.outputPath("hierarchy-dialog.png") });
  await page.keyboard.press("Escape");

  // The workbook carries the levels and the headings.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel" }).click();
  const path = testInfo.outputPath("hierarchy.xlsx");
  await (await downloading).saveAs(path);
  // Reading a workbook parses its XML; this side of the test is Node, so jsdom's parser.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require("jsdom") as { JSDOM: new () => { window: { DOMParser: typeof DOMParser } } };
  globalThis.DOMParser ??= new JSDOM().window.DOMParser;
  const back = readQuantityWorkbook(new Uint8Array(readFileSync(path)));
  expect(back.map(({ level, code }) => [level, code])).toEqual([
    [1, "13"], [2, "13.01"], [3, "13.01.01"], [3, ""], [2, "14"],
  ]);
});

test("loading an Excel file replaces the whole list, with an undo", async ({ page }) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  const none = { classes: [], predefinedTypes: [], objectTypes: [], materials: [], properties: [] };
  const count = [{ id: "n", alias: "count", kind: "count" as const }];
  const workbook = (descriptions: string[]) => ({
    name: "list.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook(descriptions.map((description, index) => ({
      code: `0${index + 1}`, description, result: null, query: { filters: { ...none, classes: ["IfcWall"] }, sources: count },
    })))),
  });
  const items = page.locator('[data-query-list] [role="listitem"]');

  // Into an empty list: nothing to replace, so no undo either.
  await page.locator("[data-quantity-workbook-input]").setInputFiles(workbook(["First A", "First B", "First C"]));
  await expect(items).toHaveCount(3);
  await expect(page.getByText("Imported 3 quantities from Excel.")).toBeVisible();

  await page.locator("[data-quantity-workbook-input]").setInputFiles(workbook(["Second A", "Second B"]));
  await expect(items).toHaveCount(2);
  await expect(items).toContainText(["Second A", "Second B"]);
  await expect(page.locator("[data-query-undo-import]")).toContainText("Replaced the list (3 lines) with 2 quantities from Excel.");
  // Kept that way across a reload.
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("dice-ifc.quantity-query-list.v1") ?? "[]").length)).toBe(2);

  await page.locator("[data-query-undo-import]").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(items).toHaveCount(3);
  await expect(page.locator("[data-query-undo-import]")).toHaveCount(0);
  await expect(items).toContainText(["First A", "First B", "First C"]);
  await expect(items.first()).toHaveAttribute("aria-current", "true");
});

test("the list window imports and downloads Excel too, and an import's undo works from there", async ({
  page,
}, testInfo) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  const none = { classes: [], predefinedTypes: [], objectTypes: [], materials: [], properties: [] };
  const count = [{ id: "n", alias: "count", kind: "count" as const }];
  const workbook = (descriptions: string[]) => ({
    name: "list.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook(descriptions.map((description, index) => ({
      code: `0${index + 1}`, description, result: null, query: { filters: { ...none, classes: ["IfcWall"] }, sources: count },
    })))),
  });
  await page.locator("[data-quantity-workbook-input]").setInputFiles(workbook(["Kept A", "Kept B"]));

  await page.locator("[data-query-list-expand]").click();
  const dialog = page.locator("[data-query-list-dialog]");
  const items = dialog.locator("[data-query-list-dialog-items] [role='listitem']");
  await expect(items).toHaveCount(2);

  // The window's Import opens the same picker, and replaces the list.
  const choosing = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Import Excel (replaces the list)" }).click();
  await (await choosing).setFiles(workbook(["New only"]));
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("New only");

  // Undo, in the window itself, puts the list back; the window stays open.
  await dialog.locator("[data-query-undo-import]").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(items).toHaveCount(2);
  await expect(dialog).toBeVisible();

  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Excel" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("ifc-quantities.xlsx");
  await download.saveAs(testInfo.outputPath("from-dialog.xlsx"));
  await expect(dialog).toBeVisible();
});


test("a grouping line lists the elements of every line under it, to isolate or hide", async ({ page }) => {
  await page.goto("/viewer?panel=quantities");
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  const none = { classes: [], predefinedTypes: [], objectTypes: [], materials: [], properties: [] };
  const count = [{ id: "n", alias: "count", kind: "count" as const }];
  const area = [{ id: "a", alias: "area", kind: "quantity" as const, setName: "Qto_WallBaseQuantities", valueName: "NetSideArea" }];
  // The fixture is two walls and a slab. Nothing is run yet: selecting the
  // heading runs what is under it, and only that.
  await page.locator("[data-quantity-workbook-input]").setInputFiles({
    name: "chapters.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(createQuantityWorkbook([
      { level: 1, code: "13", description: "WALLS", result: null, query: { filters: none, sources: [] } },
      { level: 2, code: "13.01", description: "Wall area", result: null, query: { filters: { ...none, classes: ["IfcWall"] }, sources: area, unit: "m²" } },
      { level: 2, code: "13.02", description: "Sub-chapter", result: null, query: { filters: none, sources: [] } },
      // The same walls again, one level deeper: still two elements, each under both lines.
      { level: 3, code: "13.02.01", description: "Wall count", result: null, query: { filters: { ...none, classes: ["IfcWall"] }, sources: count } },
      { level: 1, code: "14", description: "Slab count", result: null, query: { filters: { ...none, classes: ["IfcSlab"] }, sources: count } },
    ])),
  });
  const list = page.locator('[data-query-list] [role="listitem"]');
  await list.first().getByRole("button", { name: /^View/ }).click();

  const group = page.locator("[data-query-group-elements]");
  const elements = group.locator("[data-query-group-element]");
  await expect(group).toContainText("2 elements from 2 lines under this heading", { timeout: 30_000 });
  await expect(elements).toHaveCount(2);
  await expect(elements.first()).toContainText("IfcWall");
  await expect(elements.first()).toContainText("13.01, 13.02.01");
  // The lines it ran keep their values in the list; the line outside the heading was not run.
  await expect(list.nth(1)).toContainText("25 m²");
  await expect(list.nth(4)).toContainText("Not run");

  const scene = page.locator("[data-rendered-models]");
  await group.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(scene).toHaveAttribute("data-visible-entities", "1/3");
  await expect(group.getByRole("button", { name: "Show", exact: true })).toHaveAttribute("aria-pressed", "true");
  await group.getByRole("button", { name: "Show", exact: true }).click();
  await expect(scene).toHaveAttribute("data-visible-entities", "3/3");

  await group.getByRole("button", { name: "Isolate", exact: true }).click();
  await expect(scene).toHaveAttribute("data-visible-entities", "2/3");

  // A row puts that element in focus among the group's: solid, the other see-through.
  await elements.first().click();
  await expect(elements.first()).toHaveAttribute("aria-current", "true");
  await expect(scene).toHaveAttribute("data-visible-entities", "2/3");
  await expect(scene).toHaveAttribute("data-translucent-entities", "1");

  // A sub-heading holds only what is under it.
  await list.nth(2).getByRole("button", { name: /^View/ }).click();
  await expect(group).toContainText("2 elements from 1 line under this heading");
});
