import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Point clouds in the viewer.
 *
 * The fixtures are a 5 m floor patch with a 3 m wall, 1 968 points, in each
 * format; the LAS carries survey coordinates (the wall fixture's own map
 * position) and the others are local. What is asserted is what the renderer
 * actually holds — the `data-point-clouds` marker — not that a list row exists.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures");
const WALL = path.join(FIXTURES, "ifc/georeferenced-wall-ifc4.ifc");
const cloud = (name: string) => path.join(FIXTURES, "pointcloud", name);

const marker = (page: Page) => page.locator("[data-point-clouds]");

async function load(page: Page, files: string[]) {
  await page.setInputFiles('input[type="file"]', files);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/viewer");
  await expect(page.getByRole("heading", { name: "Viewer", level: 1 })).toBeVisible();
  // The point-cloud list sits under the model list.
  await page.getByRole("tab", { name: /models|modelos/i }).click();
});

for (const format of ["las", "ply", "pcd", "pts", "xyz"]) {
  test(`draws a .${format} point cloud`, async ({ page }) => {
    await load(page, [cloud(`patch.${format}`)]);

    await expect(marker(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });
    await expect(page.locator(`[data-point-cloud-item="patch.${format}"]`)).toBeVisible();
  });
}

test("places a survey-coordinate cloud on the model it was surveyed beside", async ({ page }) => {
  await load(page, [WALL]);
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "1", {
    timeout: 30_000,
  });

  await load(page, [cloud("patch.las")]);
  await expect(marker(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });

  // The cloud's own coordinates are around (-40 000, 180 000). Put in the wrong
  // frame it would be a hundred kilometres from the model; placed against the
  // model's map position it is within a few metres of the scene origin.
  const bounds = (await marker(page).getAttribute("data-point-bounds"))!.split(",").map(Number);
  expect(bounds).toHaveLength(6);
  for (const value of bounds) expect(Math.abs(value)).toBeLessThan(10);
  // Floor to the top of the wall: about 3 m of height.
  expect(bounds[4] - bounds[1]).toBeGreaterThan(2.5);
});

test("says so when a cloud has nothing to be placed against, and still draws it", async ({ page }) => {
  await load(page, [cloud("patch.las")]);
  await expect(marker(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });

  // A survey cloud with no georeferenced model: the frame defaults to the model's
  // and there is no model — the list explains instead of silently hiding it.
  await expect(page.locator("[data-point-cloud-item] [role=status]")).toBeVisible();
});

test("colour, visibility and removal reach the scene", async ({ page }) => {
  await load(page, [cloud("patch.pts")]);
  await expect(marker(page)).toHaveAttribute("data-points-visible", "1968", { timeout: 20_000 });

  const row = page.locator('[data-point-cloud-item="patch.pts"]');
  await row.getByRole("combobox", { name: /colour|cor/i }).click();
  await page.getByRole("option", { name: /height|altura/i }).click();

  await row.getByRole("button", { name: /^(hide|ocultar) patch\.pts/i }).click();
  await expect(marker(page)).toHaveAttribute("data-points-visible", "0");

  await row.getByRole("button", { name: /^(remove|remover) patch\.pts/i }).click();
  await expect(marker(page)).toHaveCount(0);
  await expect(page.locator("[data-point-cloud-item]")).toHaveCount(0);
});

test("a file that is not a point cloud fails with a message instead of hanging", async ({ page }) => {
  await page.setInputFiles('input[type="file"]', [
    { name: "broken.las", mimeType: "application/octet-stream", buffer: Buffer.from("not a las file") },
  ]);
  await expect(page.locator('[data-point-cloud-item="broken.las"]')).toContainText(/LAS|magic|header/i, {
    timeout: 20_000,
  });
  await expect(marker(page)).toHaveCount(0);
});

/*
  LAZ needs a compressed file, and there is no compressor here to make one. Run
  against a real file with POINT_CLOUD_TEST_LAZ=/path/to/file.laz; skipped
  without one, as `lib/signing/__tests__/real-container.test.ts` is.
*/
const lazFixture = process.env.POINT_CLOUD_TEST_LAZ;
test("decodes a real .laz in the browser", async ({ page }) => {
  test.skip(!lazFixture || !existsSync(lazFixture), "set POINT_CLOUD_TEST_LAZ to a .laz file");
  test.setTimeout(120_000);

  await load(page, [lazFixture as string]);
  const name = path.basename(lazFixture as string);
  await expect(page.locator(`[data-point-cloud-item="${name}"]`)).toBeVisible();
  await expect(marker(page)).toHaveAttribute("data-point-count", /^[1-9]\d{4,}$/, { timeout: 100_000 });
});
