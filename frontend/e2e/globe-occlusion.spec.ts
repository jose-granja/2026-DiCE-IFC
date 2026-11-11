import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Terrain has to occlude the model when it is in front of it.
 *
 * The globe and the model are two WebGL canvases, composited by the browser,
 * which blends by alpha and knows nothing about depth — so the model drew over
 * a hillside standing in front of it. Two contexts cannot share a depth buffer
 * and reading one back per frame would stall the pipeline, so a coarse copy of
 * the terrain lives in the three.js scene, writes depth and writes no colour.
 *
 * Only terrain. A 3D tileset's geometry is Cesium's and is not handed out, so
 * buildings from OSM or Google still do not occlude — stated here so the gap
 * is not mistaken for a regression.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

test.skip(
  !process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN,
  "no Cesium ion token configured, so there is no terrain to sample",
);

async function showGlobe(page: import("@playwright/test").Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 120_000,
  });
  await page.getByRole("tab", { name: "GIS" }).click();

  const toggle = page.getByLabel("3D world context");
  await toggle.click({ force: true });
  return toggle;
}

test("a depth occluder is built from the real terrain", async ({ page }) => {
  await showGlobe(page);

  const proxy = page.locator("[data-depth-proxy]");
  await expect(proxy).toBeAttached({ timeout: 60_000 });

  // A grid, not a token triangle.
  expect(Number(await proxy.getAttribute("data-depth-triangles"))).toBeGreaterThan(
    1_000,
  );

  // And it has relief. A proxy that is accidentally flat occludes nothing and
  // looks perfectly healthy, so the height range is what is asserted.
  const relief = await proxy.getAttribute("data-depth-relief");
  const [low, high] = (relief ?? "0..0").split("..").map(Number);
  expect(high - low).toBeGreaterThan(2);
});

test("the occluder never paints", async ({ page }) => {
  // It stands in for terrain drawn on the other canvas. If it ever wrote
  // colour it would cover the very thing it represents.
  await showGlobe(page);
  await expect(page.locator("[data-depth-proxy]")).toBeAttached({ timeout: 60_000 });

  const opaque = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const scratch = document.createElement("canvas");
    scratch.width = 64;
    scratch.height = 64;
    const context = scratch.getContext("2d")!;
    context.drawImage(canvas, 0, 0, 64, 64);
    const { data } = context.getImageData(0, 0, 64, 64);
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 250) count += 1;
    return count / (64 * 64);
  });

  // The model is a wall on a slab: a fraction of the view. A painting occluder
  // would cover most of it.
  expect(opaque).toBeLessThan(0.5);
});

test("switching the globe off takes the occluder with it", async ({ page }) => {
  // Left behind, it would punch an invisible hole in the model with no terrain
  // to justify it.
  const toggle = await showGlobe(page);
  await expect(page.locator("[data-depth-proxy]")).toBeAttached({ timeout: 60_000 });

  await toggle.click({ force: true });
  await expect(page.locator("[data-depth-proxy]")).toHaveCount(0);
});

/**
 * The sun's shadows land on the globe through a finer copy of its surface
 * round the model, which paints only shadow, over Cesium's canvas.
 */
test("the model's shadow is painted on the terrain, and only while shadows are on", async ({ page }) => {
  test.setTimeout(120_000);
  const toggle = await showGlobe(page);
  const catcher = page.locator("[data-globe-shadow-catcher]");
  await expect(catcher).toBeAttached({ timeout: 60_000 });
  // 96 × 96 cells, two triangles each: finer than the occluder's 48 × 48.
  expect(Number(await catcher.getAttribute("data-triangles"))).toBe(96 * 96 * 2);

  /** Pixels the model's canvas paints part-way: a shadow over the globe, not the model (opaque) or nothing (clear). */
  const translucent = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector<HTMLCanvasElement>("[data-model-canvas]")!;
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 30 && data[i] < 230) count += 1;
    return count;
  });

  // A winter noon, from above: the fixture stands some 50 m above the terrain
  // here, so its shadow lands on the ground a hundred metres north.
  await page.getByRole("button", { name: "Top view", exact: true }).press("Enter");
  const display = page.getByRole("button", { name: "Display" });
  await display.click();
  await page.locator("[data-sun-from='place']").getByLabel("Date").fill("2026-12-21");
  await page.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/Lisbon");
  const time = page.getByRole("slider", { name: "Time", exact: true });
  await time.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 150; step += 1) await page.keyboard.press("ArrowRight"); // 12:30, ~25° up
  await page.keyboard.press("Escape");
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let tick = 0; tick < 18; tick += 1) await page.mouse.wheel(0, 400);

  const without = await translucent();
  await display.click();
  await page.getByRole("switch", { name: "Shadows" }).click();
  await page.keyboard.press("Escape");
  const withShadows = await translucent();
  await page.locator("[data-model-canvas]").screenshot({ path: test.info().outputPath("globe-shadow.png") });
  // The shadow, as a darkening over the terrain: the 7 m model's, seen from
  // high enough to take in the ~100 m to where it lands, so a small patch.
  expect(withShadows - without).toBeGreaterThan(30);

  await toggle.click({ force: true });
  await expect(catcher).toHaveCount(0);
});

/**
 * The globe's own shadows are Cesium's shadow map, aimed along the viewer's
 * sun: 3D Tiles cast them on the terrain and on each other. The terrain only
 * receives; casting too, under a low sun it shaded itself in stripes (acne)
 * all over, which is what this checks is gone. (3D Tiles casting is not tested
 * here: on them every sample of the occluder is a ray-pick, which a
 * software-rendered headless browser takes minutes over.)
 */
test("shadows on leave bare terrain clean under a low sun", async ({ page }) => {
  test.setTimeout(150_000);
  await showGlobe(page);
  await expect(page.locator("[data-globe-shadow-catcher]")).toBeAttached({ timeout: 60_000 });

  const display = page.getByRole("button", { name: "Display" });
  await display.click();
  await page.locator("[data-sun-from='place']").getByLabel("Date").fill("2026-12-21");
  await page.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/Lisbon");
  const time = page.getByRole("slider", { name: "Time", exact: true });
  await time.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 105; step += 1) await page.keyboard.press("ArrowRight"); // 08:45, a few degrees up
  await page.keyboard.press("Escape");
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let tick = 0; tick < 16; tick += 1) await page.mouse.wheel(0, 400);

  /** The globe canvas's brightness per pixel, kept in the page under `name`. */
  const globeFrame = (name: string) => page.evaluate(async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const canvas = document.querySelector<HTMLCanvasElement>("[data-globe-canvas] canvas")!;
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    const luma = new Float32Array(data.length / 4);
    for (let at = 0; at < luma.length; at += 1) {
      luma[at] = 0.2126 * data[at * 4] + 0.7152 * data[at * 4 + 1] + 0.0722 * data[at * 4 + 2];
    }
    const frames = ((window as unknown as { __globeFrames?: Record<string, Float32Array> }).__globeFrames ??= {});
    frames[name] = luma;
  }, name);

  await globeFrame("lit");
  await display.click();
  await page.getByRole("switch", { name: "Shadows" }).click();
  await page.keyboard.press("Escape");
  await globeFrame("shaded");
  await page.locator("[data-globe-canvas] canvas").screenshot({ path: test.info().outputPath("globe-own-shadows.png") });

  // Cesium's own canvas (the model's, with the model's shadow, is not read):
  // with nothing on the terrain to cast, it hardly changes. The stripes
  // darkened a third of it.
  const share = await page.evaluate(() => {
    const frames = (window as unknown as { __globeFrames: Record<string, Float32Array> }).__globeFrames;
    let count = 0;
    for (let at = 0; at < frames.lit.length; at += 1) if (frames.lit[at] - frames.shaded[at] >= 10) count += 1;
    return count / frames.lit.length;
  });
  test.info().annotations.push({ type: "globe darkened", description: share.toFixed(4) });
  expect(share).toBeLessThan(0.01);
});
