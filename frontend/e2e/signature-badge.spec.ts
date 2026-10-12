import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

import { createSoftwareSigningProvider } from "../lib/signing/providers/software";
import { signFiles } from "../lib/signing/sign";

/**
 * The signature result in the viewer's model list.
 *
 * A container signed here with a real (software) key, so no card is needed:
 * the badge reads what verification found. What a "valid" does not cover is on
 * the About page, not repeated here.
 */

const WALL = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

// Signing parses the XML it builds, which needs a DOMParser; Node has none and the
// browser under test is a different process. jsdom's is enough for that.
const { JSDOM } = createRequire(__filename)("jsdom") as { JSDOM: new () => { window: { DOMParser: unknown } } };
(globalThis as { DOMParser?: unknown }).DOMParser ??= new JSDOM().window.DOMParser;

async function signedContainer(testInfo: import("@playwright/test").TestInfo) {
  const [output] = await signFiles(
    [{ name: "wall.ifc", bytes: new Uint8Array(fs.readFileSync(WALL)) }],
    await createSoftwareSigningProvider({ keyType: "EC" }),
  );
  const file = testInfo.outputPath("wall.ifczip");
  fs.writeFileSync(file, output.bytes);
  return file;
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [await signedContainer(testInfo)]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: /models|modelos/i }).click();
});

test("the model list shows the result and signer, and not the caveat under it", async ({ page }) => {
  const status = page.locator("[data-signature-status]").first();
  await expect(status).toContainText(/Signature valid/);

  // The row says what was found. What "valid" does and does not cover is on the
  // About page, once — not under every model.
  await expect(page.getByText(/qualified status are not checked/)).toHaveCount(0);
  await expect(page.getByText(/unchanged since it was signed/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /signature check covers/i })).toHaveCount(0);
  await expect(page.locator("[data-signature-caveat]")).toHaveCount(0);
});

test("reads in Portuguese", async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
  ]);
  await page.reload();
  await page.setInputFiles('input[type="file"]', [await signedContainer(testInfo)]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: /modelos/i }).click();

  await expect(page.locator("[data-signature-status]").first()).toContainText(/Assinatura válida/);
  await expect(page.getByText(/não são verificadas/)).toHaveCount(0);
});
