import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Opening `.ifczip` containers in the viewer.
 *
 * A plain ifcZIP is a ZIP around a model. A signed one is the same archive with
 * `META-INF/` added, which is exactly why both open the same way — see ADR 002.
 */

const PLAIN = path.resolve(__dirname, "../fixtures/ifc/containers/plain.ifczip");

/** A container signed with a real card, when this machine has one. Never committed. */
function signedContainer(): string | null {
  const configured = process.env.DICE_SIGNED_FIXTURE;
  if (configured && existsSync(configured)) return configured;

  const root = path.join(os.homedir(), "Downloads", "ifcsign");
  if (!existsSync(root)) return null;

  for (const folder of readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((entry) => statSync(entry).isDirectory())
    .sort()
    .reverse()) {
    const found = readdirSync(folder).find((name) => /\.ifczip$/i.test(name));
    if (found) return path.join(folder, found);
  }
  return null;
}

const SIGNED = signedContainer();

test("opens a plain ifcZIP", async ({ page }) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [PLAIN]);

  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "Models" }).click();

  // Listed under the name the user opened, not the entry inside the archive.
  await expect(page.getByText("plain.ifczip")).toBeVisible();
  // No signature in it, so no badge at all — an "unsigned" label on every
  // ordinary model would train people to ignore the row that matters.
  await expect(page.getByText(/Signature/)).toHaveCount(0);
});

test("shows the spatial tree from inside the container", async ({ page }) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [PLAIN]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await expect(page.getByText("DiCE-IFC Fixture Project")).toBeVisible();
});

test.describe(() => {
  test.skip(!SIGNED, "no card-signed container on this machine");

  test("verifies the signature on a signed ifcZIP and says who signed it", async ({
    page,
  }) => {
    await page.goto("/viewer");
    await page.setInputFiles('input[type="file"]', [SIGNED!]);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
      timeout: 90_000,
    });

    await page.getByRole("tab", { name: "Models" }).click();
    await expect(page.getByText(/Signature valid/)).toBeVisible({ timeout: 30_000 });

    // Integrity is not trust, and the badge has to keep saying so — one press away.
    await page.locator("[data-signature-status]").first().click();
    await expect(page.locator("[data-signature-caveat]")).toContainText(
      /Certificate trust and qualified status are not checked/,
    );
  });
});
