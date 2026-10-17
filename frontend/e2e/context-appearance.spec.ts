import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const appearance = (page: Page) => page.locator("[data-context-appearance]");
const city = {
  type: "CityJSON", metadata: { referenceSystem: "EPSG:3763" },
  vertices: [[-40003,179997,190], [-40000,179997,190], [-40000,180003,190], [-40003,180003,190], [-39997,179997,190], [-39997,180003,190]],
  CityObjects: {
    left: { type: "LandUse", attributes: { category: "Residential", name: "West plot" }, geometry: [{ type: "MultiSurface", boundaries: [[[0,1,2,3]]] }] },
    right: { type: "LandUse", attributes: { category: "Park", name: "East plot" }, geometry: [{ type: "MultiSurface", boundaries: [[[1,4,5,2]]] }] },
  },
};

async function open(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Orthographic", exact: true }).click();
  await tab(page, "Models").click();
  await page.getByRole("button", { name: "Hide georeferenced-wall-ifc4.ifc", exact: true }).click();
  await tab(page, "GIS").click();
  await page.locator('[data-context-file-input]').setInputFiles({ name: "plots.city.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(city)) });
  await expect(page.locator("[data-context-model]")).toBeAttached();
}

/** Actual rendered pixels, avoiding a test-only renderer API. */
async function pixel(page: Page, fx: number, fy: number) {
  return page.evaluate(async ({ fx, fy }) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    return [...ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data];
  }, { fx, fy });
}

async function setColour(page: Page, value: string, colour: string) {
  const input = appearance(page).getByLabel(`Colour for ${value}`, { exact: true });
  await input.evaluate((element, colour) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, colour);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, colour);
  await expect(input).toHaveValue(colour);
}

async function clickCanvas(page: Page, fx: number, fy: number) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

async function colourByCategory(page: Page) {
  await appearance(page).getByRole("combobox", { name: "Colour by property" }).click();
  await page.getByRole("option", { name: "category", exact: true }).click();
  await setColour(page, "Residential", "#00ff00");
  await setColour(page, "Park", "#ff0000");
}

test("draws feature borders, colours by values, and retains styles after inspection and hiding", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(appearance(page).getByRole("switch", { name: "Show context edges" })).toBeChecked();
  await appearance(page).getByRole("slider", { name: "Context edge width" }).press("End");
  const edgeOn = await pixel(page, 0.5, 0.35);
  await appearance(page).getByRole("switch", { name: "Show context edges" }).click();
  const edgeOff = await pixel(page, 0.5, 0.35);
  expect(edgeOff[0] - edgeOn[0]).toBeGreaterThan(30);
  await colourByCategory(page);
  const green = await pixel(page, 0.25, 0.35), red = await pixel(page, 0.75, 0.35);
  expect(green[1]).toBeGreaterThan(green[0] + 80);
  expect(red[0]).toBeGreaterThan(red[1] + 80);

  await clickCanvas(page, 0.25, 0.35);
  await expect(page.locator("[data-context-properties]")).toContainText("West plot");
  await setColour(page, "Residential", "#0000ff");
  await clickCanvas(page, 0.02, 0.02); // Clear the temporary selection highlight.
  const blue = await pixel(page, 0.25, 0.35);
  expect(blue[2]).toBeGreaterThan(blue[1] + 80);
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  expect(await pixel(page, 0.25, 0.35)).toEqual(blue);
  await tab(page, "Models").click();
  expect(await pixel(page, 0.25, 0.35)).toEqual(blue);
  await tab(page, "GIS").click();
  await appearance(page).getByRole("textbox", { name: "Filter values…" }).fill("Park");
  await expect(appearance(page).getByLabel("Colour for Residential", { exact: true })).toHaveCount(0);
  await expect(appearance(page).getByLabel("Colour for Park", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("context-colours.png") });
  await appearance(page).getByRole("combobox", { name: "Colour by property" }).click();
  await page.getByRole("option", { name: "Original colours", exact: true }).click();
  const original = await pixel(page, 0.25, 0.35);
  expect(Math.abs(original[0] - original[1])).toBeLessThan(20);
  expect(errors).toEqual([]);
});

test("hides colour groups from drawing and picking, and restores them without losing their colours", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await colourByCategory(page);
  const green = await pixel(page, 0.25, 0.35), red = await pixel(page, 0.75, 0.35);
  await clickCanvas(page, 0.25, 0.35);
  await expect(page.locator("[data-context-properties]")).toContainText("West plot");
  await appearance(page).getByRole("button", { name: "Hide Residential", exact: true }).click();
  await expect(page.locator("[data-context-properties]")).toHaveCount(0);
  const hidden = await pixel(page, 0.25, 0.35);
  expect(hidden).not.toEqual(green);
  expect(await pixel(page, 0.75, 0.35)).toEqual(red);
  await clickCanvas(page, 0.25, 0.35);
  await expect(page.locator("[data-context-properties]")).toHaveCount(0);
  // The visible triangle's draw index has changed; its metadata must not.
  await clickCanvas(page, 0.75, 0.35);
  await expect(page.locator("[data-context-properties]")).toContainText("East plot");
  await clickCanvas(page, 0.02, 0.02);
  await setColour(page, "Residential", "#0000ff");
  expect(await pixel(page, 0.25, 0.35)).toEqual(hidden);
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  await page.getByRole("switch", { name: "Context model", exact: true }).click();
  await tab(page, "Models").click();
  await tab(page, "GIS").click();
  expect(await pixel(page, 0.25, 0.35)).toEqual(hidden);
  await appearance(page).getByRole("button", { name: "Hide Park", exact: true }).click();
  expect(await pixel(page, 0.75, 0.35)).not.toEqual(red);
  await clickCanvas(page, 0.75, 0.35);
  await expect(page.locator("[data-context-properties]")).toHaveCount(0);
  await appearance(page).getByRole("button", { name: "Show all", exact: true }).click();
  const blue = await pixel(page, 0.25, 0.35);
  expect(blue[2]).toBeGreaterThan(blue[1] + 80);
  expect(await pixel(page, 0.75, 0.35)).toEqual(red);
  await appearance(page).getByRole("button", { name: "Hide Residential", exact: true }).click();
  await appearance(page).getByRole("button", { name: "Reset colours", exact: true }).click();
  await expect(appearance(page).getByRole("button", { name: "Show Residential", exact: true })).toBeVisible();
  expect(await pixel(page, 0.25, 0.35)).toEqual(hidden);
  await appearance(page).getByRole("combobox", { name: "Colour by property" }).click();
  await page.getByRole("option", { name: "Original colours", exact: true }).click();
  expect(await pixel(page, 0.25, 0.35)).not.toEqual(hidden);
  expect(errors).toEqual([]);
});

test("saves context appearance and hidden colours in a project and restores them in a fresh browser", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }));
  await open(page);
  await colourByCategory(page);
  await appearance(page).getByRole("slider", { name: "Context edge width" }).press("End");
  await appearance(page).getByRole("switch", { name: "Show context edges" }).click();
  await appearance(page).getByRole("button", { name: "Hide Residential", exact: true }).click();
  const hidden = await pixel(page, 0.25, 0.35);
  await page.locator("[data-project-menu]").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save project (.zip)…" }).click();
  const download = await downloading;
  const zip = testInfo.outputPath("context-project.zip");
  await download.saveAs(zip);
  const entries = unzipSync(new Uint8Array(await readFile(zip)));
  const manifest = JSON.parse(new TextDecoder().decode(Object.entries(entries).find(([name]) => name.endsWith("/project.json"))![1]));
  expect(manifest.context.appearance).toEqual({ edgesOn: false, edgeWidth: 3,
    colouring: { property: "category", overrides: { 'string:"Residential"': "#00ff00", 'string:"Park"': "#ff0000" }, hiddenValues: ['string:"Residential"'] } });
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await fresh.goto("/viewer");
    await fresh.locator("[data-project-zip-input]").setInputFiles(zip);
    await expect(fresh.locator("[data-context-model]")).toBeAttached({ timeout: 60_000 });
    await tab(fresh, "GIS").click();
    await expect(appearance(fresh).getByRole("switch", { name: "Show context edges" })).not.toBeChecked();
    await expect(appearance(fresh).getByRole("combobox", { name: "Colour by property" })).toContainText("category");
    await expect(appearance(fresh).getByLabel("Colour for Residential", { exact: true })).toHaveValue("#00ff00");
    expect(await pixel(fresh, 0.25, 0.35)).toEqual(hidden);
    await appearance(fresh).getByRole("button", { name: "Show Residential", exact: true }).click();
    const green = await pixel(fresh, 0.25, 0.35);
    expect(green[1]).toBeGreaterThan(green[0] + 80);
  } finally { await context.close(); }
});
