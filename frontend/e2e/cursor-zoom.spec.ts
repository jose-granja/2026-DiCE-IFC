import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The wheel zooms towards what is under the cursor, not the middle of the
 * screen (`lib/viewer/cursor-zoom.ts`). The probe is the orbit pivot: a press
 * puts it on the surface under the cursor, and its marker is that world point
 * projected every frame, so it shows where that point is on screen whether or
 * not it is drawn.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  return (await page.locator("[data-model-canvas]").boundingBox())!;
}

/** Where the pivot's world point is on screen, in page pixels. */
async function pivotOnScreen(page: Page) {
  const marker = page.locator("[data-orbit-pivot]");
  const layer = (await marker.locator("..").boundingBox())!;
  const { left, top } = await marker.evaluate((element) => ({
    left: parseFloat((element as HTMLElement).style.left),
    top: parseFloat((element as HTMLElement).style.top),
  }));
  return { x: layer.x + left, y: layer.y + top };
}

for (const projection of ["Perspective", "Orthographic"]) {
  test(`the wheel zooms about the point under the cursor in ${projection.toLowerCase()}`, async ({ page }) => {
    const box = await load(page);
    await page.getByRole("button", { name: projection, exact: true }).click();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();

    // Off the middle of the screen, on the wall; on a whole pixel, as a wheel
    // event's coordinates are.
    const cursor = { x: Math.round(box.x + box.width / 2 - 45), y: Math.round(box.y + box.height / 2 + 15) };
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator("[data-orbit-pivot]")).not.toHaveAttribute("data-orbit-pivot", "");
    const start = await pivotOnScreen(page);
    expect(Math.hypot(start.x - cursor.x, start.y - cursor.y)).toBeLessThan(1.5);
    const before = await page.locator("[data-model-canvas]").screenshot();

    for (const deltaY of [-400, -400, -400, 300]) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(80);
      // The point under the cursor has not moved; dollying to the middle of
      // the screen would have pushed it outwards, tens of pixels a step.
      const now = await pivotOnScreen(page);
      expect(Math.hypot(now.x - cursor.x, now.y - cursor.y)).toBeLessThan(1.5);
    }
    // And it did zoom.
    expect((await page.locator("[data-model-canvas]").screenshot()).equals(before)).toBe(false);
  });
}

test("zooming in stops at the surface instead of passing through it", async ({ page }) => {
  test.setTimeout(60_000);
  const box = await load(page);
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.waitForTimeout(500);
  // On a whole pixel: a pointer event's coordinates are fractional and a
  // wheel's are rounded, so the probe and the zoom would otherwise pick points
  // half a pixel apart, which two centimetres from the wall is a hundred.
  const cursor = { x: Math.round(box.x + box.width / 2 - 45), y: Math.round(box.y + box.height / 2 + 15) };
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  // A millionth of the distance and more: far past the surface.
  for (let step = 0; step < 15; step += 1) await page.mouse.wheel(0, -3000);
  await page.waitForTimeout(150);
  // Still in front of it, still under the cursor, still on screen.
  const now = await pivotOnScreen(page);
  expect(Math.hypot(now.x - cursor.x, now.y - cursor.y)).toBeLessThan(1.5);
  await expect(page.getByRole("img", { name: "Rotation point", exact: true })).toBeHidden();
  const visible = await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>("[data-orbit-pivot]")!;
    return marker.style.left !== "" && !Number.isNaN(parseFloat(marker.style.left));
  });
  expect(visible).toBe(true);
});
