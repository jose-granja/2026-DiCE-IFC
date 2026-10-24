import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const CONTEXT = path.resolve(__dirname, "../fixtures/cityjson/neighbour.city.json");

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}
async function load(page: Page) {
  await page.goto("/viewer");
  await page.locator('input[type="file"]').first().setInputFiles(IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  return (await page.locator("[data-model-canvas]").boundingBox())!;
}

test("floating panels preserve the scene, selected properties and GIS work", async ({ page }, testInfo) => {
  const canvas = await load(page);
  const tools = page.locator("#viewer-tools");
  const properties = page.locator("#viewer-properties");
  await expect(tools).toBeHidden();
  await expect(properties).toBeHidden();
  expect(canvas.width).toBe(374);
  expect(canvas.height).toBeGreaterThan(550);
  await expectNoOverflow(page);
  // Dismiss the headless browser's WebGPU fallback notification for visual QA.
  const toastClose = page.locator('[data-sonner-toast] [data-close-button]');
  if (await toastClose.isVisible()) await toastClose.tap();
  await page.screenshot({ path: testInfo.outputPath("phone-viewer.png") });

  await page.touchscreen.tap(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.getByRole("button", { name: "Properties", exact: true }).tap();
  await expect(properties.locator("[data-property-panel]")).toBeVisible();
  await properties.getByRole("tab", { name: "Properties", exact: true }).tap();
  const filter = properties.getByRole("textbox", { name: "Filter properties" });
  await filter.fill("FireRating");
  await expect(properties).toContainText("FireRating");
  await page.screenshot({ path: testInfo.outputPath("phone-properties.png") });
  await page.getByRole("button", { name: "Close properties panel" }).tap();
  await expect(properties).toBeHidden();
  await expect(page.getByRole("button", { name: "Properties", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Properties", exact: true }).tap();
  await expect(filter).toHaveValue("FireRating");
  await page.keyboard.press("Escape");
  await expect(properties).toBeHidden();

  await page.getByRole("button", { name: "Tools", exact: true }).tap();
  await tools.getByRole("tab", { name: "GIS", exact: true }).tap();
  await page.locator('input[accept*=".city.json"]').setInputFiles(CONTEXT);
  await page.getByRole("button", { name: "Close tools panel" }).tap();
  await expect(page.locator('[data-context-model="true"]')).toBeAttached({ timeout: 30_000 });
  await page.getByRole("button", { name: "Tools", exact: true }).tap();
  await expect(tools.getByRole("tab", { name: "GIS", exact: true })).toHaveAttribute("data-state", "active");
  await page.screenshot({ path: testInfo.outputPath("phone-tools.png") });
  await page.getByRole("button", { name: "Close tools panel" }).tap();
  expect((await page.locator("[data-model-canvas]").boundingBox())!.width).toBe(canvas.width);
  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "1");
});

test("narrow phones, landscape, desktop resizing and deep links", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/viewer?panel=bcf");
  const tools = page.locator("#viewer-tools");
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("tab", { name: "BCF", exact: true })).toHaveAttribute("data-state", "active");
  const close = page.getByRole("button", { name: "Close tools panel" });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const tab of await tools.getByRole("tab").all()) {
    const bounds = (await tab.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  await close.tap();
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Open display settings", exact: true }).tap();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible();
  const popoverBounds = (await popover.boundingBox())!;
  expect(popoverBounds.width).toBeLessThanOrEqual(304);
  expect(popoverBounds.x).toBeGreaterThanOrEqual(0);
  await expectNoOverflow(page);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 844, height: 390 });
  const landscape = (await page.locator("[data-model-canvas]").boundingBox())!;
  expect(landscape.width).toBe(828);
  expect(landscape.height).toBeGreaterThan(200);
  expect(landscape.y + landscape.height).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Tools", exact: true }).tap();
  const toastClose = page.locator('[data-sonner-toast] [data-close-button]');
  if (await toastClose.isVisible()) await toastClose.tap();
  await page.screenshot({ path: testInfo.outputPath("landscape-tools.png") });
  await page.getByRole("button", { name: "Close panel", exact: true }).tap({ position: { x: 820, y: 150 } });
  await expect(tools).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tools).toBeVisible();
  await expect(page.locator("#viewer-properties")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeHidden();
  const handle = page.getByRole("separator", { name: "Resize the side panel" });
  await expect(handle).toBeVisible();
  const before = (await tools.boundingBox())!.width;
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  expect((await tools.boundingBox())!.width).toBe(before + 16);
  await expectNoOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tools).toBeHidden();
  expect((await page.locator("[data-model-canvas]").boundingBox())!.width).toBe(374);
});

test("touch orbit and two-finger gestures do not select; a following tap does", async ({ page, context }) => {
  const canvas = await load(page);
  const x = canvas.x + canvas.width / 2;
  const y = canvas.y + canvas.height / 2;
  const cdp = await context.newCDPSession(page);
  const touch = (id: number, x: number, y: number) => ({ id, x, y });
  const send = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", touchPoints: ReturnType<typeof touch>[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  const cube = page.locator("[data-view-cube] [style*='transform-style']");
  const rotation = await cube.getAttribute("style");
  await send("touchStart", [touch(1, x, y)]);
  await send("touchMove", [touch(1, x + 45, y + 20)]);
  await expect(page.getByRole("img", { name: "Rotation point", exact: true })).toBeVisible();
  await expect(cube).not.toHaveAttribute("style", rotation!);
  await send("touchEnd", []);
  await expect(page.getByRole("img", { name: "Rotation point", exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Fit view", exact: true }).tap();
  await send("touchStart", [touch(1, x - 20, y)]);
  await send("touchStart", [touch(1, x - 20, y), touch(2, x + 20, y)]);
  // Even a short two-finger gesture must not pick when one finger is lifted.
  await send("touchEnd", [touch(1, x - 20, y)]);
  await send("touchEnd", []);
  await send("touchStart", [touch(1, x - 20, y)]);
  await send("touchStart", [touch(1, x - 20, y), touch(2, x + 20, y)]);
  const pivot = page.locator("[data-orbit-pivot]");
  const pivotX = await pivot.evaluate((element) => parseFloat(element.style.left));
  await send("touchMove", [touch(1, x - 45, y), touch(2, x + 45, y)]);
  await expect.poll(async () => Math.abs(await pivot.evaluate((element) => parseFloat(element.style.left)) - pivotX)).toBeGreaterThan(1);
  await send("touchEnd", []);
  await page.getByRole("button", { name: "Properties", exact: true }).tap();
  await expect(page.locator("#viewer-properties")).toContainText("Select an element in the viewport or the tree.");
  await page.getByRole("button", { name: "Close properties panel" }).tap();
  await send("touchStart", [touch(1, x, y)]);
  await send("touchCancel", []);
  await page.getByRole("button", { name: "Fit view", exact: true }).tap();
  await page.touchscreen.tap(x, y);
  await page.getByRole("button", { name: "Properties", exact: true }).tap();
  await expect(page.locator("[data-property-panel]")).toBeVisible();
});

test("mobile navigation and IDS authoring remain usable in both languages", async ({ page }, testInfo) => {
  await page.goto("/viewer");
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await page.getByRole("dialog").getByRole("link", { name: "IDS — Create", exact: true }).tap();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByLabel("Document title *").fill("Mobile IDS");
  await expectNoOverflow(page);
  await page.getByRole("tab", { name: "Live XML", exact: true }).tap();
  await expect(page.locator("pre")).toContainText("<title>Mobile IDS</title>");
  await page.getByRole("button", { name: "Add specification" }).tap();
  await page.getByLabel("Name *").fill("Walls on mobile");
  await page.screenshot({ path: testInfo.outputPath("phone-ids.png"), fullPage: true });
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Language" }).tap();
  await page.getByRole("menuitem", { name: "Português" }).tap();
  await page.getByRole("button", { name: "Abrir navegação" }).tap();
  await page.getByRole("dialog").getByRole("link", { name: "Visualizador", exact: true }).tap();
  await page.getByRole("button", { name: "Ferramentas", exact: true }).tap();
  await page.getByRole("button", { name: "Fechar painel de ferramentas" }).tap();
  await page.getByRole("button", { name: "Propriedades", exact: true }).tap();
  await page.getByRole("button", { name: "Fechar painel de propriedades" }).tap();
  await expectNoOverflow(page);
});
