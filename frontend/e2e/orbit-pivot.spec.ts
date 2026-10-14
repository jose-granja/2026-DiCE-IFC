import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  return (await page.locator("[data-model-canvas]").boundingBox())!;
}

async function markerCentre(page: Page) {
  const box = (await page.locator("[data-orbit-pivot]").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const projection of ["Perspective", "Orthographic"]) {
  test(`rotates about the pressed surface with a fixed marker in ${projection.toLowerCase()}`, async ({ page }, testInfo) => {
    const box = await load(page);
    await page.getByRole("button", { name: projection, exact: true }).click();
    const press = { x: box.x + box.width / 2 - 45, y: box.y + box.height / 2 + 15 };
    const marker = page.getByRole("img", { name: "Rotation point", exact: true });
    await expect(marker).toBeHidden();
    const cube = page.locator("[data-view-cube] [style*='transform-style']");
    const originalRotation = await cube.getAttribute("style");

    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await expect(marker).toBeVisible();
    const pivot = await marker.getAttribute("data-orbit-pivot");
    const start = await markerCentre(page);
    expect(Math.hypot(start.x - press.x, start.y - press.y)).toBeLessThan(1);
    await page.mouse.move(press.x + 100, press.y + 45, { steps: 12 });
    await expect(cube).not.toHaveAttribute("style", originalRotation!);
    await expect(marker).toHaveAttribute("data-orbit-pivot", pivot!);
    const finish = await markerCentre(page);
    expect(Math.hypot(finish.x - start.x, finish.y - start.y)).toBeLessThan(1);
    await expect(page.getByText("Select an element in the viewport or the tree.")).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath("rotation-pivot.png") });
    await page.mouse.up();
    await expect(marker).toBeHidden();
    await expect(page.locator("[data-orbit-pivot]")).toHaveAttribute("data-orbit-pivot", pivot!);

    // Empty-space rotation still uses the saved pivot and shows it only while held.
    await page.mouse.move(box.x + 15, box.y + 15);
    await page.mouse.down();
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("data-orbit-pivot", pivot!);
    await page.mouse.up();
    await expect(marker).toBeHidden();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await expect(marker).toBeHidden();
  });
}

test("replaces the pivot on another surface press and retains it for empty-space gestures and pan", async ({ page }) => {
  const box = await load(page);
  const marker = page.locator("[data-orbit-pivot]");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(centre.x - 40, centre.y);
  await expect(marker).toHaveAttribute("data-orbit-pivot", /-?\d/);
  await expect(marker).toBeHidden();
  const first = await marker.getAttribute("data-orbit-pivot");
  await page.mouse.click(centre.x + 40, centre.y);
  await expect(marker).not.toHaveAttribute("data-orbit-pivot", first!);
  const second = await marker.getAttribute("data-orbit-pivot");
  await page.mouse.click(box.x + 15, box.y + 15);
  await expect(marker).toHaveAttribute("data-orbit-pivot", second!);
  const projectedPoint = () => marker.evaluate((element) => ({
    x: parseFloat(element.style.left), y: parseFloat(element.style.top),
  }));
  const start = await projectedPoint();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centre.x + 40, centre.y + 20, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await expect(marker).toHaveAttribute("data-orbit-pivot", second!);
  await expect(marker).toBeHidden();
  await expect.poll(async () => {
    const current = await projectedPoint();
    return Math.hypot(current.x - start.x, current.y - start.y);
  }).toBeGreaterThan(10);
});
