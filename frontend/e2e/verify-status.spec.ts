import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";

import { createSoftwareSigningProvider } from "../lib/signing/providers/software";
import { signFiles } from "../lib/signing/sign";

/**
 * The Status column on the verify page: a badge, so the result reads at a glance.
 *
 * Containers are signed here with a real (software) key, so no card is needed,
 * and one is then altered after signing.
 */

const { JSDOM } = createRequire(__filename)("jsdom") as { JSDOM: new () => { window: { DOMParser: unknown } } };
(globalThis as { DOMParser?: unknown }).DOMParser ??= new JSDOM().window.DOMParser;

const WALL = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

async function signed(testInfo: import("@playwright/test").TestInfo, name: string, tamper = false) {
  const [output] = await signFiles(
    [{ name: "wall.ifc", bytes: new Uint8Array(fs.readFileSync(WALL)) }],
    await createSoftwareSigningProvider({ keyType: "EC" }),
  );
  let bytes = output.bytes;
  if (tamper) {
    // Change the model after it was signed: the signature is then over something else.
    const entries = unzipSync(bytes);
    entries["wall.ifc"] = strToU8(new TextDecoder().decode(entries["wall.ifc"]).replace("IFCWALL", "IFCSLAB"));
    bytes = zipSync(entries);
  }
  const file = testInfo.outputPath(name);
  fs.writeFileSync(file, bytes);
  return file;
}

test("a valid container gets a green badge, an altered one a red badge, side by side", async ({ page }, testInfo) => {
  await page.goto("/sign/verify");
  await page.setInputFiles('input[type="file"]', [
    await signed(testInfo, "good.ifczip"),
    await signed(testInfo, "altered.ifczip", true),
  ]);

  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(2);

  const good = rows.filter({ hasText: "good.ifczip" }).locator("[data-verify-status]");
  const altered = rows.filter({ hasText: "altered.ifczip" }).locator("[data-verify-status]");

  await expect(good).toHaveAttribute("data-verify-status", "verified", { timeout: 30_000 });
  await expect(good).toContainText("Integrity verified");
  await expect(good).toHaveAttribute("data-variant", "success");

  await expect(altered).toHaveAttribute("data-verify-status", "not-verified");
  await expect(altered).toContainText("Not verified");
  await expect(altered).toHaveAttribute("data-variant", "destructive");
});

test("the badges read in Portuguese", async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
  ]);
  await page.goto("/sign/verify");
  await page.setInputFiles('input[type="file"]', [await signed(testInfo, "good.ifczip")]);
  await expect(page.locator("[data-verify-status='verified']")).toBeVisible({ timeout: 30_000 });
});
