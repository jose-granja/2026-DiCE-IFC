import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Every tool tab opens on the same header: the tab's icon and its panel's
 * title, with the panel's own actions on the right — before a model is open
 * and after.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

const TABS: Array<[string, string]> = [
  ["models", "Models"],
  ["structure", "Spatial structure"],
  ["classes", "Filters"],
  ["lens", "Lens"],
  ["quantities", "Quantity query"],
  ["georef", "Georeferencing"],
  ["gis", "GIS context"],
  ["section", "Section planes"],
  ["measure", "Measurements"],
  ["ids", "IDS verification"],
  ["clash", "Clash detection"],
  ["bcf", "BCF topics"],
];

const tab = (page: import("@playwright/test").Page, value: string) =>
  page.locator(`[role="tab"][id$="-trigger-${value}"]`);

for (const loaded of [false, true]) {
  test(`each tool tab has one header, with its tab's icon and its title${loaded ? ", with a model open" : ""}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/viewer");
    if (loaded) {
      await page.setInputFiles('input[type="file"]', [FIXTURE]);
      await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
    }
    const heights = new Set<number>();
    for (const [value, title] of TABS) {
      await tab(page, value).click();
      const header = page.locator(`[data-panel-header="${value}"]:visible`);
      await expect(header).toHaveCount(1);
      await expect(header.getByRole("heading", { level: 2 })).toHaveText(title);
      // The same icon as the tab that opened it.
      const icon = async (root: import("@playwright/test").Locator) =>
        root.locator("svg").first().getAttribute("class");
      const tabIcon = (await icon(tab(page, value)))!.match(/lucide-[a-z-]+/)?.[0];
      expect(tabIcon).toBeTruthy();
      expect(await icon(header.getByRole("heading"))).toContain(tabIcon!);
      heights.add(Math.round((await header.boundingBox())!.height));
    }
    // One height, buttons or none, so switching tabs does not make the panel jump.
    expect([...heights]).toHaveLength(1);
  });
}
