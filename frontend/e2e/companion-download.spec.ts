import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The signing setup page offers the compiled companion from this app's own
 * origin. The files come from `npm run copy:companion`, so a checkout that
 * never built the companion has none and the page says so instead.
 */

const FOLDER = path.resolve(__dirname, "../public/companion");
const built = fs.existsSync(FOLDER) && fs.readdirSync(FOLDER).length > 0;

test.describe("companion download", () => {
  test.skip(!built, "no compiled companion in public/companion");

  test("offers the macOS and Windows builds, and they download", async ({ page, request }) => {
    await page.goto("/sign/setup");

    const links = page.locator('a[download][href^="/companion/"]');
    await expect(links.first()).toBeVisible({ timeout: 15_000 });

    const hrefs = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")!));
    // This machine's build as the button, the others listed beside it.
    expect(hrefs.some((href) => href.endsWith(".pkg"))).toBe(true);
    expect(hrefs.some((href) => href.endsWith(".exe"))).toBe(true);

    for (const href of hrefs) {
      const response = await request.get(href);
      expect(response.ok(), href).toBe(true);
      const body = await response.body();
      expect(body.length).toBe(fs.statSync(path.join(FOLDER, path.basename(href))).size);
    }
  });

  test("sends nothing off this machine to offer it", async ({ page, baseURL }) => {
    const own = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      // The page's own handshake with the companion, on loopback, is not a download.
      if (url.origin !== own && url.origin !== "http://127.0.0.1:8765") foreign.push(request.url());
    });
    await page.goto("/sign/setup");
    await expect(page.locator('a[download][href^="/companion/"]').first()).toBeVisible({ timeout: 15_000 });
    expect(foreign).toEqual([]);
  });
});
