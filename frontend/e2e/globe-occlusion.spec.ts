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
  await page.getByRole("tab", { name: "Geo" }).click();

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
