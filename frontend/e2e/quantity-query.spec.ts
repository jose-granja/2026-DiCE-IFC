import path from "node:path";
import { expect, test } from "@playwright/test";

import { createQuantityWorkbook } from "../lib/spreadsheets/quantity-workbook";

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
  await expect(page.locator("[data-property-panel] h3")).toHaveText(rowName);

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
