import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

/**
 * The model's shadow falls on what is around it, not just on itself: here a
 * context parcel 10 m below the georeferenced wall (about 7 m across). The
 * shadow camera reaches along the sun to it, so the shadow lands about 30 m
 * away; it used to stop at the models' own size, and the ground got none.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

// 300 m of ground round the wall (EPSG:3763, as the wall's map conversion), 10 m below the parcel the other context tests use.
const ground = {
  type: "CityJSON", metadata: { referenceSystem: "EPSG:3763" },
  vertices: [[-40150, 179850, 180], [-39850, 179850, 180], [-39850, 180150, 180], [-40150, 180150, 180]],
  CityObjects: { ground: { type: "LandUse", attributes: { name: "Ground" },
    geometry: [{ type: "MultiSurface", boundaries: [[[0, 1, 2, 3]]] }] } },
};

/**
 * The canvas's brightness per pixel, kept in the page as `window.__frames[name]`
 * (read in the page, as the other pixel tests do, so nothing is decoded here).
 */
async function frame(page: Page, name: string) {
  await page.waitForTimeout(800);
  await page.evaluate(async (name) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const luma = new Float32Array(data.length / 4);
    for (let at = 0; at < luma.length; at += 1) {
      luma[at] = 0.2126 * data[at * 4] + 0.7152 * data[at * 4 + 1] + 0.0722 * data[at * 4 + 2];
    }
    const frames = ((window as unknown as { __frames?: Record<string, Float32Array> }).__frames ??= {});
    frames[name] = luma;
  }, name);
}

/** Pixels at least `by` darker in frame `shaded` than in frame `lit`, within fractions of the view (`left`–`right`, `top`–`bottom`). */
function darkened(
  page: Page,
  lit: string,
  shaded: string,
  { by = 10, top = 0, bottom = 1, left = 0, right = 1 } = {},
): Promise<number> {
  return page.evaluate(({ lit, shaded, by, top, bottom, left, right }) => {
    const frames = (window as unknown as { __frames: Record<string, Float32Array> }).__frames;
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const width = canvas.width;
    const rows = frames[lit].length / width;
    let count = 0;
    for (let row = Math.floor(rows * top); row < Math.floor(rows * bottom); row += 1) {
      for (let column = Math.floor(width * left); column < Math.floor(width * right); column += 1) {
        const at = row * width + column;
        if (frames[lit][at] - frames[shaded][at] >= by) count += 1;
      }
    }
    return count;
  }, { lit, shaded, by, top, bottom, left, right });
}

test("the model's shadow falls on the context model, however far it reaches", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "GIS", exact: true }).click();
  // The whole parcel: clipping keeps what is near the model, and its corners are not.
  await page.getByRole("switch", { name: "Clip context to the model" }).click();
  await page.locator("[data-context-file-input]").setInputFiles({
    name: "ground.city.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(ground)),
  });
  await expect(page.locator("[data-context-model]")).toBeAttached();
  // From above, so the whole shadow is in view whichever side of the wall it falls.
  await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Orthographic", exact: true }).click();
  // Zoomed out, so the view reaches several times the model's own size past it.
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let tick = 0; tick < 14; tick += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }

  const display = page.getByRole("button", { name: "Display" });
  await display.click();
  await page.locator("[data-sun-from='place']").getByLabel("Date").fill("2026-12-21");
  await page.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/Lisbon");
  await page.keyboard.press("Escape");
  const time = page.getByRole("slider", { name: "Time", exact: true });
  const shadows = page.getByRole("switch", { name: "Shadows" });

  // 12:30 is about solar noon in winter: the sun due south, 25° up, so from
  // above the wall's shadow runs north, up the frame.
  await display.click();
  await time.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 150; step += 1) await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-sun-position]")).toContainText("25° high");
  await page.keyboard.press("Escape");
  await frame(page, "lit");
  await display.click();
  await shadows.click();
  await page.keyboard.press("Escape");
  await frame(page, "shaded");
  await page.locator("[data-model-canvas]").screenshot({ path: test.info().outputPath("shadow.png") });

  // On the ground, north of the wall and clear of it: above the model, which
  // is in the middle of the view.
  expect(await darkened(page, "lit", "shaded", { top: 0, bottom: 0.45 })).toBeGreaterThan(500);
  // Nothing darkens south of it, on the sunny side.
  expect(await darkened(page, "lit", "shaded", { top: 0.6, bottom: 1 })).toBe(0);
});

// A 20 m block 60–70 m east of the wall, on 300 m of ground at the wall's own foot.
const block = {
  type: "CityJSON", metadata: { referenceSystem: "EPSG:3763" },
  vertices: [
    [-40150, 179850, 190], [-39850, 179850, 190], [-39850, 180150, 190], [-40150, 180150, 190],
    [-39940, 179995, 190], [-39930, 179995, 190], [-39930, 180005, 190], [-39940, 180005, 190],
    [-39940, 179995, 210], [-39930, 179995, 210], [-39930, 180005, 210], [-39940, 180005, 210],
  ],
  CityObjects: {
    ground: { type: "LandUse", geometry: [{ type: "MultiSurface", boundaries: [[[0, 1, 2, 3]]] }] },
    block: { type: "Building", geometry: [{ type: "Solid", boundaries: [[
      [[4, 5, 6, 7]], [[8, 9, 10, 11]], [[4, 5, 9, 8]], [[5, 6, 10, 9]], [[6, 7, 11, 10]], [[7, 4, 8, 11]],
    ]] }] },
  },
};

test("the context model's own buildings cast shadows, away from the model", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "GIS", exact: true }).click();
  await page.getByRole("switch", { name: "Clip context to the model" }).click();
  await page.locator("[data-context-file-input]").setInputFiles({
    name: "block.city.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(block)),
  });
  await expect(page.locator("[data-context-model]")).toBeAttached();
  await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Orthographic", exact: true }).click();
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let tick = 0; tick < 16; tick += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }

  const display = page.getByRole("button", { name: "Display" });
  await display.click();
  await page.locator("[data-sun-from='place']").getByLabel("Date").fill("2026-12-21");
  await page.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/Lisbon");
  const time = page.getByRole("slider", { name: "Time", exact: true });
  await time.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 150; step += 1) await page.keyboard.press("ArrowRight"); // 12:30
  await page.keyboard.press("Escape");
  await frame(page, "lit");
  await display.click();
  await page.getByRole("switch", { name: "Shadows" }).click();
  await page.keyboard.press("Escape");
  await frame(page, "shaded");
  await page.locator("[data-model-canvas]").screenshot({ path: test.info().outputPath("block-shadow.png") });

  // The block is right of the wall, which is in the middle; its shadow runs
  // north of it, up the right of the view, nowhere near the model.
  expect(await darkened(page, "lit", "shaded", { left: 0.65, right: 1, top: 0, bottom: 0.5 })).toBeGreaterThan(300);
});
