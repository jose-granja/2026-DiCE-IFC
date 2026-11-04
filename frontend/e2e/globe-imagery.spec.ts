import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The map under the terrain: Google Maps 2D, through Cesium ion (ADR 003,
 * amended 2026-11-04). Against the real assets, so it needs an ion token at
 * build time and is skipped without one, like the other globe tests.
 *
 * What only the real thing shows: that ion's proxy serves the tiles (and so
 * the CSP needs no Google origin), that switching the map asks for the other
 * asset, and that Google's logo and data credit are on screen with them.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

test.skip(!process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN, "no Cesium ion token configured, so there is no globe");

async function showGlobe(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 120_000 });
  await page.getByRole("tab", { name: "GIS" }).click();
  await page.getByLabel("3D world context").click({ force: true });
}

/** Tile requests by host and path, collected from the moment the page opens. */
function watchRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return {
    to: (fragment: string) => urls.filter((url) => url.includes(fragment)),
  };
}

test("the terrain carries Google's road map, through ion, with Google's logo and credit", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  const requests = watchRequests(page);
  await showGlobe(page);

  // A road map unless the user chose otherwise.
  await expect(page.getByLabel("Map", { exact: true })).toContainText("Google road map");
  await expect.poll(() => requests.to("assets.ion.cesium.com/proxy/3830184").length, { timeout: 60_000 }).toBeGreaterThan(0);

  const attribution = page.locator("[data-globe-attribution]");
  await expect(attribution).toContainText("© Cesium ion", { timeout: 30_000 });
  await expect(attribution).toContainText("Google");
  const logo = page.locator("[data-globe-google-logo]");
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator("[data-globe-google-terms]")).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: testInfo.outputPath("roadmap.png") });

  // Satellite is another asset; asking for it fetches from that one.
  await page.getByLabel("Map", { exact: true }).click();
  await page.getByRole("option", { name: "Google satellite", exact: true }).click();
  await expect.poll(() => requests.to("assets.ion.cesium.com/proxy/3830182").length, { timeout: 60_000 }).toBeGreaterThan(0);
  // The credit for the area in view, not for the planet: a line, not a paragraph.
  await expect(attribution).toContainText("Imagery", { timeout: 15_000 });
  expect((await attribution.innerText()).length).toBeLessThan(400);
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: testInfo.outputPath("satellite.png") });

  // Nothing went to MapTiler, and nothing to Google directly: ion proxies the map.
  expect(requests.to("api.maptiler.com")).toEqual([]);
  expect(requests.to("tile.googleapis.com")).toEqual([]);
  expect(violations).toEqual([]);
});

test("no map leaves only terrain, and Google's credit goes with it", async ({ page }) => {
  test.setTimeout(150_000);
  await showGlobe(page);
  const attribution = page.locator("[data-globe-attribution]");
  await expect(page.locator("[data-globe-google-logo]")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Map", { exact: true }).click();
  await page.getByRole("option", { name: "No map (terrain only)" }).click();
  await expect(page.locator("[data-globe-google-logo]")).toHaveCount(0);
  await expect(attribution).not.toContainText("Google", { timeout: 10_000 });
  await expect(attribution).toContainText("terrain via Cesium ion");
});

test("under Google Photorealistic the map is not drawn, and cannot be chosen", async ({ page }) => {
  test.setTimeout(150_000);
  await showGlobe(page);
  await expect(page.locator("[data-globe-attribution]")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("World context", { exact: true }).click();
  await page.getByRole("option", { name: "Google Photorealistic 3D" }).click();
  await expect(page.getByLabel("Map", { exact: true })).toBeDisabled();
  await expect(page.getByText("covers the ground itself")).toBeVisible();
});
