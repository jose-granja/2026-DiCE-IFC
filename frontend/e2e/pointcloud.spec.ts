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

/** Pixels in the model canvas darker than `limit` (0–255 luma), over opaque ones. */
async function darkPixels(page: Page, limit = 60): Promise<number> {
  return page.evaluate(async (threshold) => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    // Two frames, so the switch has reached the renderer before the read.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();
    const copy = document.createElement("canvas");
    copy.width = image.width;
    copy.height = image.height;
    const context = copy.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (data[i + 3] > 200 && luma < threshold) count += 1;
    }
    return count;
  }, limit);
}

test("shades a cloud's edges by default, like ifclite.com, and can be switched off", async ({ page }) => {
  await load(page, [cloud("patch.ply")]);
  await expect(marker(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });
  await page.getByRole("button", { name: "Zoom to patch.ply" }).click();

  // On by default, and points start at 4 px.
  const toggle = page.getByRole("switch", { name: "Edge shading" });
  await expect(toggle).toBeChecked();
  await expect(marker(page)).toHaveAttribute("data-point-edge-shading", "true");
  await expect(page.getByRole("slider", { name: "Point size" })).toHaveAttribute("aria-valuenow", "4");

  // The shading is the dark outline round the silhouette and along each step
  // in depth (where the wall stands on the floor); a flat-coloured cloud on a
  // light backdrop has almost none of those pixels.
  await page.waitForTimeout(500);
  const shaded = await darkPixels(page);
  await toggle.click();
  await expect(marker(page)).toHaveAttribute("data-point-edge-shading", "false");
  const flat = await darkPixels(page);
  expect(shaded).toBeGreaterThan(200);
  expect(shaded).toBeGreaterThan(flat * 3);

  // And back: the same picture as before, not a slowly drifting one.
  await toggle.click();
  expect(Math.abs((await darkPixels(page)) - shaded)).toBeLessThan(shaded * 0.05);
});

/** The model canvas's pixels, read after two frames. */
async function framePixels(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const image = new Image();
    image.src = canvas.toDataURL("image/png");
    await image.decode();
    const copy = document.createElement("canvas");
    copy.width = image.width;
    copy.height = image.height;
    const context = copy.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, copy.width, copy.height).data);
  });
}

test("edge-shaded clouds are still hidden by the model in front of them", async ({ page }) => {
  // The shading draws the cloud through a full-screen pass that writes the
  // cloud's own depth. Without that depth the cloud paints over the wall it was
  // scanned beside, which changes a great many pixels; with it, switching the
  // shading on changes only the edges.
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // The model first, so the survey cloud is placed against its map position —
  // beside and in front of the wall rather than a hundred kilometres away.
  await load(page, [WALL]);
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "1", {
    timeout: 30_000,
  });
  await load(page, [cloud("patch.las")]);
  await expect(marker(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });
  await page.getByRole("button", { name: "Zoom to patch.las" }).click();
  await page.waitForTimeout(800);

  const shaded = await framePixels(page);
  await page.getByRole("switch", { name: "Edge shading" }).click();
  await expect(marker(page)).toHaveAttribute("data-point-edge-shading", "false");
  const flat = await framePixels(page);

  let changed = 0;
  let wall = 0;
  for (let i = 0; i < flat.length; i += 4) {
    const luma = (data: number[]) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (Math.abs(luma(shaded) - luma(flat)) > 40) changed += 1;
    // The wall's grey, as drawn without the shading.
    if (Math.abs(flat[i] - flat[i + 1]) < 8 && Math.abs(flat[i + 1] - flat[i + 2]) < 8 && luma(flat) < 200) wall += 1;
  }
  console.log(`EDL-DIFF changed=${changed} wall=${wall} total=${flat.length / 4}`);
  expect(changed).toBeGreaterThan(0);
  expect(changed).toBeLessThan(wall * 0.25);
  expect(errors.filter((error) => /shader|WebGL|GL_/i.test(error))).toEqual([]);
});
