import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Sketching on the live 3D view (`SketchOverlay.tsx`).
 *
 * What a browser shows and nothing else does: that the layer takes the
 * pointer from the camera, that the marks end up in the pixels of the BCF
 * snapshot and of the downloaded PNG, and that the topic's snapshot editor
 * opens them again as shapes.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const RED: [number, number, number] = [0xe5, 0x48, 0x4d];

async function loadModel(page: Page, baseURL: string | undefined) {
  // Pinned, so the button names below are the English ones (AGENTS.md §2b).
  await page.context().addCookies([{ name: "dice-locale", value: "en", url: baseURL ?? "http://127.0.0.1:3000" }]);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
}

async function sketch(page: Page) {
  await page.getByRole("button", { name: "Sketch on the view" }).click();
  const layer = page.locator("[data-viewer-sketch]");
  const canvas = layer.locator("[data-annotation-canvas]");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
  const dragOn = async (from: readonly [number, number], to: readonly [number, number]) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
  };
  return { layer, canvas, at, dragOn };
}

function redPixels(png: Buffer | Uint8Array, page: Page) {
  return page.evaluate(async ([bytes, [r, g, b]]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) < 24 && Math.abs(data[i + 1] - g) < 24 && Math.abs(data[i + 2] - b) < 24) count += 1;
    }
    return count;
  }, [[...png], RED] as const);
}

test("a sketch on the live view becomes a BCF topic, its marks baked in and still editable", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await loadModel(page, baseURL);
  const { layer, canvas, at, dragOn } = await sketch(page);

  // The layer has the pointer: a drag draws instead of orbiting. The view
  // cube's rotation is the camera's, so it is the witness.
  const cube = page.locator("[data-view-cube] [style*='transform-style']");
  const rotation = () => cube.evaluate((element) => (element as HTMLElement).style.transform);
  const rotationBefore = await rotation();
  await dragOn(at(0.2, 0.7), at(0.6, 0.4));
  await page.getByRole("button", { name: "Revision cloud" }).click();
  await dragOn(at(0.55, 0.3), at(0.85, 0.6));
  await expect(canvas).toHaveAttribute("data-annotation-count", "2");

  // The eraser takes the mark it is clicked on, and leaves the other.
  await page.getByRole("button", { name: /^Eraser/ }).click();
  await page.mouse.click(...at(0.4, 0.55));
  await expect(canvas).toHaveAttribute("data-annotation-count", "1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "2");
  expect(await rotation()).toBe(rotationBefore);

  // Nor does the wheel zoom. Both pictures include the marks, which are on
  // the page over the canvas.
  const before = await page.locator("[data-model-canvas]").screenshot();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  expect((await page.locator("[data-model-canvas]").screenshot()).equals(before)).toBe(true);

  await page.getByRole("button", { name: "New BCF topic" }).click();
  await expect(page.getByText("BCF topic created from the current view with 2 marks.")).toBeVisible();
  await expect(layer).toHaveCount(0);

  // The BCF panel is open on the new topic, with one viewpoint whose image has the marks.
  await expect(page.locator("[data-viewpoint]")).toHaveCount(1);
  const img = page.locator("[data-viewpoint] img").first();
  await expect(img).toBeVisible();
  const red = await img.evaluate(async (element, [r, g, b]) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) < 24 && Math.abs(data[i + 1] - g) < 24 && Math.abs(data[i + 2] - b) < 24) count += 1;
    }
    return count;
  }, RED);
  expect(red).toBeGreaterThan(200);

  // The snapshot editor opens them again as shapes.
  await page.getByRole("button", { name: "Annotate the snapshot" }).click();
  await expect(page.locator("[data-annotation-editor] [data-annotation-canvas]")).toHaveAttribute(
    "data-annotation-count",
    "2",
  );
});

test("a sketch downloads as a PNG, and Esc discards it with an undo", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await loadModel(page, baseURL);
  const { layer, canvas, at, dragOn } = await sketch(page);
  await dragOn(at(0.2, 0.7), at(0.6, 0.4));
  await expect(canvas).toHaveAttribute("data-annotation-count", "1");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PNG" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sketch-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
  const png = await readFile(await download.path());
  expect(await redPixels(png, page)).toBeGreaterThan(200);
  await expect(layer).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(layer).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(layer.locator("[data-annotation-canvas]")).toHaveAttribute("data-annotation-count", "1");
});
