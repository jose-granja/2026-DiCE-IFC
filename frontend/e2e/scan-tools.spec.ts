import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Section and measure on what is loaded around a model — a point cloud, a
 * context model — even with no model at all. A scan is often opened first, to
 * check it before the model arrives, and the tools that answer "how high is
 * this wall" have nothing to do with whether an IFC file is open.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures");
const CLOUD = path.join(FIXTURES, "pointcloud/patch.ply");
const CITYGML = path.join(FIXTURES, "citygml/two-blocks.gml");

const tab = (page: Page, value: string) => page.locator(`[role="tab"][id$="-trigger-${value}"]`);
const clouds = (page: Page) => page.locator("[data-point-clouds]");

async function openCloud(page: Page) {
  await page.goto("/viewer?panel=models");
  await page.setInputFiles('input[type="file"]', [CLOUD]);
  await expect(clouds(page)).toHaveAttribute("data-point-count", "1968", { timeout: 20_000 });
  await page.getByRole("button", { name: "Zoom to patch.ply" }).click();
  await page.waitForTimeout(500);
}

/** Pixels of the model canvas that are not the backdrop. */
async function drawnPixels(page: Page): Promise<number> {
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
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const [r, g, b] = [data[0], data[1], data[2]];
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 30) count += 1;
    }
    return count;
  });
}

/**
 * Move over the canvas until the measuring tool's snap preview says there is
 * something to measure under the cursor, then click there. Searching rather
 * than guessing a pixel: a point cloud is points with gaps, not a surface.
 */
async function clickSomethingNear(page: Page, fx: number, fy: number) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  const marker = page.locator("[data-rendered-models]");
  for (let ring = 0; ring < 12; ring += 1) {
    for (let k = 0; k < Math.max(1, ring * 8); k += 1) {
      const angle = (k / Math.max(1, ring * 8)) * Math.PI * 2;
      const x = box.x + box.width * fx + Math.cos(angle) * ring * 3;
      const y = box.y + box.height * fy + Math.sin(angle) * ring * 3;
      await page.mouse.move(x, y);
      if ((await marker.getAttribute("data-snap-preview")) === "true") {
        await page.mouse.click(x, y);
        return;
      }
    }
  }
  throw new Error(`Nothing to measure near (${fx}, ${fy}).`);
}

test("a viewport button switches the edge shading, in step with the list's switch", async ({ page }) => {
  await openCloud(page);
  const button = page.locator("[data-edge-shading-toggle]");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveAccessibleName("Turn off point-cloud edge shading");

  await button.click();
  await expect(clouds(page)).toHaveAttribute("data-point-edge-shading", "false");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("switch", { name: "Edge shading" })).not.toBeChecked();

  await page.getByRole("switch", { name: "Edge shading" }).click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(clouds(page)).toHaveAttribute("data-point-edge-shading", "true");
});

test("the button is not offered with no point cloud to shade", async ({ page }) => {
  await page.goto("/viewer");
  await expect(page.locator("[data-edge-shading-toggle]")).toHaveCount(0);
});

test("sections a point cloud with no model loaded", async ({ page }) => {
  await openCloud(page);
  const before = await drawnPixels(page);

  await tab(page, "section").click();
  await expect(page.getByText(/Load a model, a point cloud or a context model/)).toHaveCount(0);
  await page.getByRole("button", { name: "Plan", exact: true }).click();

  // The plane's range is the cloud's own height, floor to wall top, as the
  // renderer reports the cloud's extent (min x, y, z, max x, y, z).
  const bounds = (await clouds(page).getAttribute("data-point-bounds"))!.split(",").map(Number);
  const slider = page.getByRole("slider", { name: "Plan position" });
  expect(Number(await slider.getAttribute("aria-valuemin"))).toBeLessThanOrEqual(bounds[1] + 0.01);
  expect(Number(await slider.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(bounds[4] - 0.01);

  // And it cuts: the top half of the wall goes.
  await expect.poll(() => drawnPixels(page)).toBeLessThan(before * 0.9);
});

test("measures on a point cloud with no model loaded", async ({ page }) => {
  await openCloud(page);
  await tab(page, "measure").click();
  await expect(page.getByText(/Load a model, a point cloud or a context model/)).toHaveCount(0);
  await page.getByRole("button", { name: "Distance" }).click();

  await clickSomethingNear(page, 0.35, 0.65);
  await clickSomethingNear(page, 0.65, 0.65);
  await expect(page.getByRole("button", { name: "Remove distance 1" })).toBeVisible();
});

test("sections and measures a context model with no model loaded", async ({ page }) => {
  await page.goto("/viewer?panel=georef");
  await page.locator('input[accept*=".city.json"]').setInputFiles(CITYGML);
  await expect(page.locator("[data-context-model='true']")).toHaveAttribute("data-context-triangles", "24", {
    timeout: 45_000,
  });

  await tab(page, "section").click();
  await expect(page.getByText(/Load a model, a point cloud or a context model/)).toHaveCount(0);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Plan position" })).toBeVisible();

  await tab(page, "measure").click();
  await expect(page.getByText(/Load a model, a point cloud or a context model/)).toHaveCount(0);
});
