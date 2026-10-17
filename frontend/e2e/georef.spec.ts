import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Georeferencing, end to end.
 *
 * Vitest covers the grading, the transforms, the solver and the hull. What only
 * a browser shows is whether the module reads a real model, whether proj4 and
 * MapLibre survive the bundler, and whether the export actually produces a file.
 *
 * Georeferencing is a panel in the viewer now, not a page: the question it
 * answers is a 3D one, so the basemap goes under the model rather than beside
 * it. `/georef` redirects here.
 */

const IFC4 = path.resolve(
  __dirname,
  "../fixtures/ifc/georeferenced-wall-ifc4.ifc",
);

/** Load a model, then open the georeferencing panel. */
/** The panel groups its controls under sub-tabs; open the one a test needs. */
async function openSection(page: Page, name: "Report" | "Place" | "Points") {
  await page.getByRole("tab", { name }).click();
}

async function loadAndOpenGeoref(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("tab", { name: "Geo" }).click();
  await expect(page.getByRole("tab", { name: "Report", exact: true })).toBeVisible();
}

test("the old page redirects to the viewer panel", async ({ page }) => {
  await page.goto("/georef");
  await expect(page).toHaveURL(/\/viewer\?panel=georef/);
  await expect(page.getByRole("tab", { name: "Geo", exact: true })).toHaveAttribute("data-state", "active");
});

test("tells you to load a model when none is open", async ({ page }) => {
  await page.goto("/viewer?panel=georef");
  await expect(
    page.getByText("Load a model to check its georeferencing."),
  ).toBeVisible();
});

test("the model stays loaded when the panel opens", async ({ page }) => {
  // Switching panels must not disturb the federation.
  await loadAndOpenGeoref(page);
  await expect(page.locator("[data-rendered-models='1']")).toBeAttached();
});

test("GIS holds the context controls separately from Geo and stays off until asked for", async ({ page }) => {
  // It is the only part of this app that talks to a third party, and a tile
  // request says roughly where the building is (ADR 003).
  await loadAndOpenGeoref(page);
  await expect(page.getByLabel("3D world context")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Load context", exact: true })).not.toBeVisible();
  await page.getByRole("tab", { name: "GIS", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Report", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Load context", exact: true })).toBeVisible();
  await expect(page.getByLabel("3D world context")).toBeVisible();
  await expect(page.getByLabel("3D world context")).not.toBeChecked();
  await expect(
    page.getByText(/Tile requests reveal roughly where this model is/),
  ).toHaveCount(0);
});

test("grades the fixture as fully georeferenced", async ({ page }) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Report");

  // The fixture carries IfcMapConversion + IfcProjectedCRS + TrueNorth + site
  // coordinates, so it is LoGeoRef 50.
  await expect(page.getByText("LoGeoRef 50").first()).toBeVisible();
  await expect(page.getByText(/Fully georeferenced/i)).toBeVisible();

  await expect(page.getByText("IfcMapConversion").first()).toBeVisible();
  await expect(page.getByText("TrueNorth")).toBeVisible();
  await expect(page.getByText(/EPSG:3763/).first()).toBeVisible();

  // The compound-degree latitude must be decoded, not shown raw.
  await expect(page.getByText(/41° 33′/)).toBeVisible();
});

test("shows the file's placement and where the origin lands", async ({ page }) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Place");

  await expect(page.getByLabel("Eastings")).toHaveValue("-40000");
  await expect(page.getByLabel("Northings")).toHaveValue("180000");
  await expect(page.getByLabel("Orthogonal height")).toHaveValue("190");
  await expect(page.getByLabel("Grid rotation")).toHaveValue("0");

  // proj4 has to run in the browser for this to appear at all. The readout is
  // the *model origin*, which is a different point from the IfcSite coordinates
  // shown in the report — hence scoping to the readout rather than the page.
  const readout = page
    .locator("div")
    .filter({ hasText: /^Model origin lands at/ })
    .last();
  await expect(readout).toBeVisible();
  await expect(readout).toContainText(/\d+° \d+′ [\d.]+″ N/);
  await expect(readout).toContainText(/\d+° \d+′ [\d.]+″ W/);
});

test("editing the placement updates the diff, and revert undoes it", async ({
  page,
}) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Place");

  await expect(page.getByText("No changes — matches the file")).toBeVisible();

  await page.getByLabel("Eastings").fill("-39000");
  await expect(page.getByText("Changes to be written")).toBeVisible();

  // GIS uses the same draft; switching tabs must not reseed it from the IFC.
  await page.getByRole("tab", { name: "GIS", exact: true }).click();
  await expect(page.getByLabel("Eastings")).not.toBeVisible();
  await page.getByRole("tab", { name: "Geo", exact: true }).click();
  await expect(page.getByLabel("Eastings")).toHaveValue("-39000");
  await expect(page.getByText("Changes to be written")).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: "Eastings" });
  await expect(row).toContainText("-40000.000");
  await expect(row).toContainText("-39000.000");

  await page.getByRole("button", { name: /Revert to the file/i }).click();
  await expect(page.getByText("No changes — matches the file")).toBeVisible();
});

test("warns when the model lands outside the chosen CRS", async ({ page }) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Place");

  // Madeira's grid, with mainland coordinates: a classic wrong-CRS mistake that
  // otherwise shows up only as a dot in the sea.
  await page.getByRole("combobox", { name: "Coordinate reference system" }).click();
  await page.getByRole("option", { name: /Madeira/ }).click();

  await expect(page.getByText(/falls outside/i)).toBeVisible();
});

test("fits a placement from control points and reports residuals", async ({
  page,
}) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Points");

  await expect(page.getByText(/No control points/)).toBeVisible();
  // Two points is the minimum that determines rotation and scale.
  await page.getByRole("button", { name: "Add point" }).click();
  await page.getByRole("button", { name: "Add point" }).click();

  // Point 1: model origin ↔ a surveyed easting/northing.
  await page.getByLabel(/Model.*X$/).first().fill("0");
  await page.getByLabel(/Model.*Y$/).first().fill("0");
  await page.getByLabel(/Surveyed.*E$/).first().fill("-40000");
  await page.getByLabel(/Surveyed.*N$/).first().fill("180000");

  // Point 2: 100 m along the model's +x ↔ 100 m east.
  await page.getByLabel(/Model.*X$/).nth(1).fill("100");
  await page.getByLabel(/Model.*Y$/).nth(1).fill("0");
  await page.getByLabel(/Surveyed.*E$/).nth(1).fill("-39900");
  await page.getByLabel(/Surveyed.*N$/).nth(1).fill("180000");

  await page.getByRole("button", { name: "Fit placement" }).click();

  // An exact correspondence must fit exactly, and say so. Scoped to the fit
  // summary: the same numbers also appear in the write-back diff.
  const summary = page.getByRole("tabpanel", { name: "Points" });
  await expect(summary.getByText("RMSE", { exact: true })).toBeVisible();
  await expect(summary.getByText("0 mm").first()).toBeVisible();
  // 100 m along +x mapping to 100 m east means no rotation and unit scale.
  await expect(summary.getByText("0.0000°")).toBeVisible();
  await expect(summary.getByText("1.00000000")).toBeVisible();
});

test("refuses to fit with fewer than two points", async ({ page }) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Points");
  await page.getByRole("button", { name: "Add point" }).click();

  // Rotation and scale are undetermined from one point; the button says so by
  // being disabled rather than by failing after the click.
  await expect(page.getByRole("button", { name: "Fit placement" })).toBeDisabled();
});

test("exports a corrected IFC without sending anything", async ({
  page,
  baseURL,
}) => {
  const ownOrigin = new URL(baseURL!).origin;
  const suspicious: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) {
      suspicious.push(request.url());
    }
    const body = request.postData();
    if (body && body.includes("ISO-10303-21")) {
      suspicious.push(`${request.method()} carried IFC`);
    }
  });

  await loadAndOpenGeoref(page);
  await openSection(page, "Place");
  await page.getByLabel("Eastings").fill("-39000");

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Export corrected IFC/i }).click();
  const file = await download;

  expect(file.suggestedFilename()).toBe(
    "georeferenced-wall-ifc4-georeferenced.ifc",
  );
  expect(suspicious).toEqual([]);
});

test("edits the IfcSite location, shows it as a pin, and writes it", async ({ page }) => {
  await loadAndOpenGeoref(page);
  await openSection(page, "Place");

  // The file's own site position, in decimal degrees and as the IFC writes it.
  await expect(page.getByLabel("Latitude")).toHaveValue(/^41\.551/);

  await page.getByLabel("Latitude").fill("41.6");
  await page.getByLabel("Longitude").fill("-8.4");
  await expect(page.getByText(/41° 36′/)).toBeVisible();
  // Out of range is refused rather than committed.
  await page.getByLabel("Latitude").fill("141");
  await expect(page.getByText(/between .*90 and 90 degrees/)).toBeVisible();
  await page.getByLabel("Latitude").fill("41.6");

  // The elevation reads as the file has it, and is editable.
  await expect(page.getByLabel("Elevation")).toHaveValue("190");
  await page.getByLabel("Elevation").fill("201.5");
  await expect(page.getByText("IfcSite.RefElevation", { exact: true })).toBeVisible();

  // The change is listed with the others.
  await expect(page.getByText("IfcSite.RefLatitude", { exact: true })).toBeVisible();

  // Switching the model origins on adds the pin without a console error.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: /show model origins/i }).click();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Export corrected IFC/i }).click();
  const text = fs.readFileSync(await (await download).path(), "latin1");
  expect(text).toMatch(/IFCSITE\([^;]*\(41,36,0,0\),\(-8,-24,0,0\),201\.5,/);
});

test("renders the module with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await loadAndOpenGeoref(page);
  await openSection(page, "Report");
  await page.waitForTimeout(1500);

  expect(errors).toEqual([]);
});
