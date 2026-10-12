import path from "node:path";
import { expect, test } from "@playwright/test";

import { createQuantityWorkbook } from "../lib/spreadsheets/quantity-workbook";

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

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

  // Definitions stay available when the panel unmounts while another viewer
  // tab is open; only model-derived result rows are recalculated.
  // By id, not by name: the viewer's own class-filter tab and this panel's
  // filter tab are both called "Filters".
  await page.locator('[role="tab"][id$="-trigger-classes"]').click();
  await page.locator('[role="tab"][id$="-trigger-quantities"]').click();
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
