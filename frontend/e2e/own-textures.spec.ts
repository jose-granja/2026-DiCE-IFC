import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The model's own textures (ADR 016, part A): drawn from the file or its
 * .ifczip, painted over by a selection, and never fetched from a URL.
 *
 * Both fixtures texture a 2 m panel with a 4×4 red and blue checker, so the
 * texture shows as red and blue pixels the grey of the panel's colour cannot
 * make.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/ifc");

/** Red and blue checker pixels on the canvas, and where the red ones are. */
async function checker(page: Page) {
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas[data-model-canvas]") as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let red = 0;
    let blue = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 140 && g < 90 && b < 90) {
        red += 1;
        x += (i / 4) % copy.width;
        y += Math.floor(i / 4 / copy.width);
      } else if (b > 140 && r < 90 && g < 120) {
        blue += 1;
      }
    }
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    return { red, blue, at: red ? { x: (x / red) * scale, y: (y / red) * scale } : null };
  });
}

async function open(page: Page, file: string) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [path.join(FIXTURES, file)]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
}

test("draws a texture the file carries, under a selection's colour when selected", async ({ page }) => {
  await open(page, "textured-blob-ifc4.ifc");
  const shown = await checker(page);
  expect(shown.red).toBeGreaterThan(500);
  expect(shown.blue).toBeGreaterThan(500);

  // Selecting the panel paints it in the selection colour, texture and all.
  const box = (await page.locator("canvas[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + shown.at!.x, box.y + shown.at!.y);
  await expect(page.locator("[data-property-panel]")).toBeVisible();
  expect((await checker(page)).red).toBeLessThan(shown.red / 10);
});

test("draws an image from the .ifczip, and never fetches one the model links to", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("textures.invalid")) outside.push(request.url());
  });
  await open(page, "textured-image-ifc4.ifczip");
  await expect.poll(async () => (await checker(page)).red, { timeout: 10_000 }).toBeGreaterThan(500);
  // The linked one stays its colour, and the viewer says why.
  await expect(page.getByText(/1 texture is on the internet/)).toBeVisible();
  expect(outside).toEqual([]);
});

test("says when a texture's image was not opened with the model", async ({ page }) => {
  // The same model without its archive: the image it names is not there.
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', {
    name: "textured-image-ifc4.ifc",
    mimeType: "application/x-step",
    buffer: await import("node:fs/promises").then(async (fs) => {
      const { unzipSync } = await import("fflate");
      const entries = unzipSync(new Uint8Array(await fs.readFile(path.join(FIXTURES, "textured-image-ifc4.ifczip"))));
      return Buffer.from(entries["textured-image-ifc4.ifc"]);
    }),
  });
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.getByText(/1 texture refers to an image that is not inside the model/)).toBeVisible();
  await expect(page.getByText(/1 texture is on the internet/)).toBeVisible();
  expect((await checker(page)).red).toBe(0);
});
