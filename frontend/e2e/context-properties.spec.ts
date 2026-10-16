import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const MAP = path.resolve(__dirname, "../fixtures/geopackage/curved-map.gpkg");
const panel = (page: Page) => page.locator("[data-context-properties]");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Geo", exact: true }).click();
  await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Orthographic", exact: true }).click();
}

async function clickAt(page: Page, fx = 0.08, fy = 0.5, button: "left" | "right" = "left") {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button });
}

const city = {
  type: "CityJSON", metadata: { referenceSystem: "EPSG:3763" },
  vertices: [[-40020, 179980, 190], [-39980, 179980, 190], [-39980, 180020, 190], [-40020, 180020, 190]],
  CityObjects: { "parcel-A": { type: "LandUse", attributes: { name: "School plot", area: 0, occupied: false, description: "<script>text only</script>" },
    geometry: [{ type: "MultiSurface", boundaries: [[[0, 1, 2, 3]]] }] } },
};

test("inspects and highlights context, filters metadata, and switches back to IFC properties", async ({ page }, testInfo) => {
  await load(page);
  await page.locator('[data-context-file-input]').setInputFiles({ name: "parcel.city.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(city)) });
  await expect(page.locator("[data-context-model]")).toBeAttached();
  const canvas = page.locator("[data-model-canvas]");
  const before = await canvas.screenshot();
  await clickAt(page);
  await expect(panel(page).getByRole("heading", { name: "School plot" })).toBeVisible();
  await expect(panel(page)).toContainText("parcel-A");
  await expect(panel(page).locator("dt", { hasText: /^area$/ }).locator("..")).toContainText("0");
  await expect(panel(page).getByText("No", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("<script>text only</script>", { exact: true })).toBeVisible();
  const after = await canvas.screenshot({ path: testInfo.outputPath("context-highlight.png") });
  expect(after.equals(before)).toBe(false);
  await panel(page).getByRole("textbox").fill("occupied");
  await expect(panel(page).getByText("No", { exact: true })).toBeVisible();
  await expect(panel(page).locator("dt", { hasText: /^area$/ })).toHaveCount(0);
  await panel(page).getByRole("textbox").fill("missing field");
  await expect(panel(page)).toContainText("No properties match your search.");

  // Context has no IFC hide/isolate/class actions, even on right click.
  await clickAt(page, 0.08, 0.5, "right");
  await expect(page.locator("[data-viewer-context-menu]")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // The IFC is above the map at the centre; nearest visible geometry wins.
  await clickAt(page, 0.5, 0.5);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("[data-property-panel]")).toContainText(/Ifc(Wall|Slab)/);
  await clickAt(page);
  await expect(panel(page)).toBeVisible();
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("Select an element in the viewport or the tree.")).toBeVisible();
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  await clickAt(page);
  await expect(panel(page)).toBeVisible();
  await page.getByRole("button", { name: "Remove the context model" }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("picks the visible GeoPackage land layer over a coplanar sea layer", async ({ page }) => {
  await load(page);
  await page.locator('[data-context-file-input]').setInputFiles(MAP);
  await expect(page.locator("[data-context-model]")).toBeAttached({ timeout: 30_000 });
  await clickAt(page);
  await expect(panel(page)).toContainText("GeoPackage");
  await expect(panel(page).getByText("Land", { exact: true })).toBeVisible();
  await expect(panel(page).locator("dt", { hasText: /^fid$/ })).toBeVisible();
});

test("shows the actual Portugal GeoPackage attributes without sending file data", async ({ page, baseURL }) => {
  test.skip(!process.env.CONTEXT_TEST_GPKG, "Set CONTEXT_TEST_GPKG to the local PortugalSmallScaleMap.gpkg");
  const foreign: string[] = [], payloads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) foreign.push(request.url());
    if (request.postDataBuffer()?.length) payloads.push(request.url());
  });
  await load(page);
  await page.locator('[data-context-file-input]').setInputFiles(process.env.CONTEXT_TEST_GPKG!);
  await expect(page.locator("[data-context-model]")).toBeAttached({ timeout: 30_000 });
  await clickAt(page);
  await expect(panel(page).getByRole("heading", { name: "Portugal", exact: true })).toBeVisible();
  await expect(panel(page).getByText("World Map", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("PRT", { exact: true }).first()).toBeVisible();
  expect(foreign).toEqual([]);
  expect(payloads).toEqual([]);
});
