import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The viewport's right-click menu: visibility actions and selection by class
 * or floor, with a background menu that can restore the whole model.
 *
 * `facets-ifc4.ifc` has two walls on one storey and a slab on another, which is
 * what tells "same class" and "same floor" apart from each other and from
 * "everything".
 */

const FACETS = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const menu = (page: Page) => page.locator("[data-viewer-context-menu]");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FACETS]);
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "1", {
    timeout: 30_000,
  });
}

/** Right-click across the canvas until something is under the pointer. */
async function rightClickAnElement(page: Page, type: RegExp) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
    for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: "right" });
      if (await menu(page).isVisible().catch(() => false)) {
        if (type.test((await menu(page).innerText()) ?? "")) {
          return { x: box.x + box.width * fx, y: box.y + box.height * fy };
        }
        await page.keyboard.press("Escape");
        await expect(menu(page)).toHaveCount(0);
      }
    }
  }
  throw new Error(`No ${type} found under the pointer`);
}

test.beforeEach(async ({ page }) => {
  await load(page);
});

test("right-clicking an element offers visibility and selection actions and names its class", async ({ page }) => {
  await rightClickAnElement(page, /IfcWall/);

  // The item names the class it will select, not "the same class".
  await expect(menu(page).getByRole("menuitem", { name: "Select all IfcWall" })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem", { name: "Hide selected" })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem", { name: "Isolate selected" })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem", { name: "Show all", exact: true })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem")).toHaveCount(5);
  await expect(menu(page).getByRole("menuitem", { name: /^Select all Ifc\w+$/ })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem", { name: "Select all on the same floor" })).toBeEnabled();
});

test("selects every element of the same IFC class", async ({ page }) => {
  await rightClickAnElement(page, /IfcWall/);
  await menu(page).getByRole("menuitem", { name: /^Select all Ifc\w+$/ }).click();

  // Two walls, and not the slab.
  await expect(page.getByText(/Selected 2 elements of class IfcWall/)).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
});

test("selects every element on the same floor, and no other floor's", async ({ page }) => {
  await rightClickAnElement(page, /IfcWall/);
  await menu(page).getByRole("menuitem", { name: "Select all on the same floor" }).click();

  // The two walls share a storey; the slab is on the other one.
  await expect(page.getByText(/Selected 2 elements on /)).toBeVisible();
});

test("hides the selected element and restores it from the background menu", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Show all" })).toBeDisabled();

  await rightClickAnElement(page, /Ifc/);
  await menu(page).getByRole("menuitem", { name: "Hide selected" }).click();

  // `Show all` only has something to do once something is hidden.
  await expect(page.getByRole("button", { name: "Show all" })).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "2/3");

  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6, { button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveCount(1);
  await menu(page).getByRole("menuitem", { name: "Show all", exact: true }).click();
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "3/3");
  await expect(page.getByRole("button", { name: "Show all" })).toBeDisabled();
});

test("isolates the clicked element and restores all from its menu", async ({ page }) => {
  const point = await rightClickAnElement(page, /IfcWall/);
  await menu(page).getByRole("menuitem", { name: "Isolate selected" }).click();
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "1/3");
  await expect(menu(page)).toHaveCount(0);

  await page.mouse.click(point.x, point.y, { button: "right" });
  await menu(page).getByRole("menuitem", { name: "Show all", exact: true }).click();
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "3/3");
});

test("isolates the existing multi-selection and offers only Show all over empty space", async ({ page }, testInfo) => {
  const point = await rightClickAnElement(page, /IfcWall/);
  await menu(page).getByRole("menuitem", { name: "Select all IfcWall", exact: true }).click();
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.screenshot({ path: testInfo.outputPath("element-menu.png") });
  await menu(page).getByRole("menuitem", { name: "Isolate selected" }).click();
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "2/3");

  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6, { button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("background-menu.png") });
  await menu(page).getByRole("menuitem", { name: "Show all", exact: true }).click();
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute("data-visible-entities", "3/3");
});

test("empty space offers only Show all, and right-button dragging still pans without opening a menu", async ({ page }) => {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;

  await page.mouse.click(box.x + 6, box.y + 6, { button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveCount(1);
  await expect(menu(page).getByRole("menuitem", { name: "Show all", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // Pan with the right button across where an element is: the camera moves, no menu.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await expect(menu(page)).toHaveCount(0);
});

test("reads in Portuguese", async ({ page, context }) => {
  await context.addCookies([
    { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
  ]);
  await page.reload();
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "0");
  await page.setInputFiles('input[type="file"]', [FACETS]);
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "1", {
    timeout: 30_000,
  });

  await rightClickAnElement(page, /Ifc/);
  await expect(menu(page).getByRole("menuitem", { name: "Ocultar selecionados" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Isolar selecionados" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Mostrar tudo", exact: true })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: /^Selecionar todos os Ifc\w+$/ })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Selecionar todos no mesmo piso" })).toBeVisible();
});
