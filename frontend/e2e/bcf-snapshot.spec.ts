import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * A BCF snapshot has to show what the author was looking at.
 *
 * The model's canvas is transparent so the world context can show through it
 * on screen. That made `toDataURL` on it alone a mostly-transparent PNG
 * whenever the globe was on — 2083 of 2304 sampled pixels — which renders as
 * blank wherever the snapshot is displayed. The two canvases are separate
 * WebGL contexts and cannot share a buffer, so the renderer composites them.
 *
 * These assert on the **pixels of the stored image**, not on an `<img>` being
 * present: a fully transparent PNG is a perfectly valid image element.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

/** Decode the stored snapshot and report how much of it is see-through. */
async function analyse(page: Page) {
  const source = await page.locator("img").first().getAttribute("src");
  expect(source).toBeTruthy();

  return page.evaluate(
    (url) =>
      new Promise<{ colours: number; transparent: number; of: number }>((resolve) => {
        const scratch = document.createElement("canvas");
        scratch.width = 48;
        scratch.height = 48;
        const context = scratch.getContext("2d")!;
        const image = new Image();
        image.onload = () => {
          context.drawImage(image, 0, 0, 48, 48);
          const { data } = context.getImageData(0, 0, 48, 48);
          const colours = new Set<number>();
          let transparent = 0;
          for (let i = 0; i < data.length; i += 4) {
            colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
            if (data[i + 3] < 250) transparent += 1;
          }
          resolve({ colours: colours.size, transparent, of: 48 * 48 });
        };
        image.src = url;
      }),
    source!,
  );
}

async function raiseTopic(page: Page, title: string) {
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Title *").fill(title);
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(page).toHaveURL(/panel=bcf/);
  await expect(page.locator("img").first()).toBeVisible({ timeout: 20_000 });
}

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });
}

test("a snapshot is opaque and shows the model", async ({ page }) => {
  await load(page);
  await raiseTopic(page, "Plain snapshot");

  const result = await analyse(page);
  expect(result.transparent).toBe(0);
  // More than a flat fill: the model is in there.
  expect(result.colours).toBeGreaterThan(4);
});

test("a snapshot taken with the world context on is not transparent", async ({
  page,
}) => {
  // The regression this file exists for.
  await load(page);
  await page.getByRole("tab", { name: "Geo" }).click();

  const toggle = page.getByLabel("3D world context");
  test.skip(
    !(await toggle.isEnabled()),
    "no ion token configured, so there is no globe to composite",
  );
  await toggle.click({ force: true });
  await expect(page.locator("[data-globe-canvas] canvas")).toBeAttached({
    timeout: 30_000,
  });
  await page.waitForTimeout(6_000);

  await raiseTopic(page, "With world context");

  const result = await analyse(page);
  expect(result.transparent).toBe(0);
});

test("the stored snapshot is the size of the viewport, not a stub", async ({
  page,
}) => {
  await load(page);
  await raiseTopic(page, "Sized snapshot");

  const size = await page
    .locator("img")
    .first()
    .evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
    }));

  expect(size.width).toBeGreaterThan(200);
  expect(size.height).toBeGreaterThan(100);
});
