import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The view cube, as on ifclite.com: every face a 3 × 3 grid whose middle is
 * the face and whose sides and corners are the cube's edges and corners.
 * Hovering one lights it on every face that shows it; clicking one looks from
 * there. The cube's own rotation is the camera's (`-elevation`, `-azimuth`),
 * so it is what these tests read the camera by.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
}

/** The cube's rotation, in degrees: [about x, about y]. */
async function rotation(page: Page): Promise<[number, number]> {
  const transform = await page.locator("[data-view-cube] [style*='transform-style']").evaluate((element) => (element as HTMLElement).style.transform);
  const match = /rotateX\((-?[\d.e-]+)deg\) rotateY\((-?[\d.e-]+)deg\)/.exec(transform);
  expect(match, transform).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

/** The cell `key` as drawn on `face`. */
const zone = (page: Page, face: string, key: string) => page.locator(`[data-cube-face="${face}"] [data-view-zone="${key}"]`);

test("an edge and a corner light up on every face that shows them", async ({ page }) => {
  await load(page);
  // The corner between front, right and top.
  await zone(page, "front", "1,1,1").hover();
  await expect(page.locator('[data-view-zone="1,1,1"][data-lit]')).toHaveCount(3);
  await expect(page.locator("[data-view-zone][data-lit]")).toHaveCount(3);
  // The edge between front and top.
  await zone(page, "front", "0,1,1").hover();
  await expect(page.locator('[data-view-zone="0,1,1"][data-lit]')).toHaveCount(2);
  await expect(page.locator("[data-view-zone][data-lit]")).toHaveCount(2);
  // The face's middle lights all of that face.
  await zone(page, "front", "0,0,1").hover();
  await expect(page.locator('[data-cube-face="front"] [data-lit]')).toHaveCount(9);
  await expect(page.locator("[data-view-zone][data-lit]")).toHaveCount(9);
  await page.mouse.move(5, 5);
  await expect(page.locator("[data-view-zone][data-lit]")).toHaveCount(0);
});

test("clicking an edge or a corner looks from there; a face's middle, from the face", async ({ page }) => {
  await load(page);

  await zone(page, "front", "0,1,1").click();
  await expect.poll(async () => (await rotation(page)).map((angle) => Math.round(angle))).toEqual([-45, 0]);

  // From the new view, the same corner is reached through the top face.
  await zone(page, "top", "1,1,1").click();
  const [x, y] = await rotation(page);
  expect(x).toBeCloseTo(-(Math.asin(1 / Math.sqrt(3)) * 180) / Math.PI, 1);
  expect(y).toBeCloseTo(-45, 1);

  await zone(page, "front", "0,0,1").click();
  await expect.poll(async () => (await rotation(page)).map((angle) => Math.round(angle))).toEqual([0, 0]);

  // Only the six faces are in the tab order; edges and corners are for the pointer.
  await expect(page.locator('[data-view-zone][tabindex="-1"]')).toHaveCount(6 * 8);
  await expect(page.locator("[data-view-face]")).toHaveCount(6);
  await expect(zone(page, "front", "1,1,1")).toHaveAttribute("aria-label", /Front \/ Right \/ Top|Frente \/ Direita \/ Cima/);
});
