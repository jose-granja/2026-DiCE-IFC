import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * End-to-end coverage for the viewer.
 *
 * Vitest covers the federation arithmetic and the batching; this covers the
 * things only a real browser has — Web Workers, WASM, WebGL and the file input.
 * If this passes, a model genuinely parsed, tessellated and rendered.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/ifc");
const IFC4 = path.join(FIXTURES, "georeferenced-wall-ifc4.ifc");
const IFC4X3 = path.join(FIXTURES, "bridge-ifc4x3.ifc");

/** The picker button uses the File System Access API, which Playwright cannot
 *  drive, so drive the fallback input directly. */
async function loadModels(page: import("@playwright/test").Page, files: string[]) {
  await page.setInputFiles('input[type="file"]', files);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/viewer");
  await expect(
    page.getByRole("heading", { name: "Viewer", level: 1 }),
  ).toBeVisible();
});

test("carries the local-processing badge", async ({ page }) => {
  await expect(
    page.getByRole("link", { name: /processed locally/i }),
  ).toBeVisible();
});

test("parses a model and shows its structure and classes", async ({ page }) => {
  await loadModels(page, [IFC4]);

  // The tree is the accessible equivalent of the canvas, so it is what we
  // assert on rather than pixels.
  const tree = page.getByRole("tree", { name: /spatial structure/i });
  await expect(tree.getByText("georeferenced-wall-ifc4.ifc")).toBeVisible({
    timeout: 60_000,
  });
  await expect(tree.getByRole("button", { name: /^Site/ })).toBeVisible();
  // Anchored: an unanchored match also catches this row's own "Hide Level 0…"
  // and "Isolate Level 0…" buttons, which is a strict-mode violation.
  await expect(tree.getByRole("button", { name: /^Level 0/ })).toBeVisible();

  await page.getByRole("tab", { name: "Filters", exact: true }).click();
  await expect(page.getByText("IfcWall")).toBeVisible();
});

test("renders IFC4x3 sectioned solids as well as linearly placed elements", async ({ page }) => {
  await loadModels(page, [path.join(FIXTURES, "alignment-bridge-ifc4x3.ifc")]);

  // The old WASM parsed both products but silently dropped the sectioned girder.
  // Count the entities actually handed to the renderer, not just the spatial tree.
  await expect(page.locator("[data-visible-entities]")).toHaveAttribute(
    "data-visible-entities", "2/2", { timeout: 60_000 },
  );
});

test("selecting an element shows its properties", async ({ page }) => {
  await loadModels(page, [IFC4]);

  const tree = page.getByRole("tree", { name: /spatial structure/i });
  await expect(tree.getByRole("button", { name: /^Level 0/ })).toBeVisible({
    timeout: 60_000,
  });

  // Storeys are collapsed by default — their children are the elements.
  await tree.getByRole("button", { name: "Expand" }).first().click();

  // #71 is Wall A, which carries Pset_WallCommon in the fixture. Contained
  // elements are `treeitem`s, not plain buttons — the tree is the canvas's
  // accessible equivalent, so its roles are part of the contract. Grouped by
  // class and labelled by name once it resolves (briefly "#71" before then).
  await tree.getByRole("treeitem", { name: "Wall A" }).click();

  await expect(page.getByRole("heading", { name: "Wall A" })).toBeVisible();

  // Property sets are their own tab in the information panel.
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(page.getByText("Pset_WallCommon").first()).toBeVisible();
  await expect(page.getByText("FireRating")).toBeVisible();
  await expect(page.getByText("REI 60")).toBeVisible();
  // An IFC boolean must read as a boolean, not as "true" or "1".
  await expect(page.getByText("IsExternal")).toBeVisible();
  await expect(page.getByText("Yes")).toBeVisible();
});

test("federates two models and reports how each was aligned", async ({ page }) => {
  await loadModels(page, [IFC4, IFC4X3]);

  await page.getByRole("tab", { name: /^Models/ }).click();

  await expect(page.getByText("georeferenced-wall-ifc4.ifc")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("bridge-ifc4x3.ifc")).toBeVisible();

  // Both fixtures carry an IfcMapConversion in EPSG:3763, so both align exactly
  // and the panel must say so rather than leaving it implicit.
  await expect(page.getByText(/Federation origin from/i)).toBeVisible();
  await expect(page.getByText("Aligned").first()).toBeVisible();

  await expect(page.getByText("IFC4X3_ADD2")).toBeVisible();
});

test("closing a model removes it from the federation", async ({ page }) => {
  await loadModels(page, [IFC4]);
  await page.getByRole("tab", { name: /^Models/ }).click();
  await expect(page.getByText("georeferenced-wall-ifc4.ifc")).toBeVisible({
    timeout: 60_000,
  });

  // Each row's button names its own model: with a federation loaded, five
  // buttons all called "Close model" tell a screen-reader user nothing.
  await page
    .getByRole("button", { name: "Close georeferenced-wall-ifc4.ifc" })
    .click();
  await expect(page.getByText("No models loaded.")).toBeVisible();
});

test("loads and renders with no console errors at all", async ({ page }) => {
  const errors: string[] = [];

  // Registered BEFORE navigating. Attaching these after `page.goto` misses
  // everything thrown during the initial load and hydration — which is exactly
  // where a CSP or server/client mismatch shows up.
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(
    page.getByRole("tree", { name: /spatial structure/i }).getByText("Level 0"),
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);

  expect(errors).toEqual([]);
});

test("sends no model data over the network while loading", async ({
  page,
  baseURL,
}) => {
  const ownOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  const suspicious: string[] = [];

  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) foreign.push(request.url());

    // POSTs are not forbidden — the auth Server Action that checks the session
    // is one, and AGENTS.md §1 allows it. What is forbidden is a request body
    // carrying model data, so that is what gets asserted: no STEP header, no
    // IFC entity lines, and nothing large enough to be a model.
    const body = request.postData();
    if (!body) return;
    if (body.includes("ISO-10303-21") || /IFC[A-Z]{3,}\(/.test(body)) {
      suspicious.push(`${request.method()} ${request.url()} — looks like IFC`);
    }
    if (body.length > 8 * 1024) {
      suspicious.push(
        `${request.method()} ${request.url()} — ${body.length} byte body`,
      );
    }
  });

  await loadModels(page, [IFC4, IFC4X3]);
  await expect(
    page.getByRole("tree", { name: /spatial structure/i }).getByText("Level 0"),
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1000);

  expect(foreign).toEqual([]);
  expect(suspicious).toEqual([]);
});

test("the side panels are docked, not floating, over the canvas", async ({ page }) => {
  // If a panel ever went back to overlaying the canvas, its bounding box
  // would start at the same origin as the canvas's rather than beside it.
  const panelBox = (await page.locator("aside").first().boundingBox())!;
  const canvasBox = (await page.locator("[data-model-canvas]").boundingBox())!;
  expect(canvasBox.x).toBeGreaterThanOrEqual(panelBox.x + panelBox.width);
});

test("dragging the handle resizes the side panel", async ({ page }) => {
  const panelBox = (await page.locator("aside").first().boundingBox())!;
  const handle = page.getByRole("separator", { name: "Resize the side panel" });
  const handleBox = (await handle.boundingBox())!;
  const start = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 96, start.y, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(() => page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(panelBox.width + 96, 0);
});

test("a stored panel width is restored on load", async ({ page }) => {
  // Leave enough room for the saved width: smaller desktop viewports cap each
  // panel's visible width to keep the canvas usable.
  await page.setViewportSize({ width: 1440, height: 900 });
  // Persisted, not just live state: a returning visit keeps the width the
  // user chose rather than resetting to the default every time. Set through
  // localStorage directly — a separate concern from the drag gesture itself,
  // which the previous test already covers — so this only has to prove the
  // *read* side of `useResizableWidth` (`PanelResizeHandle.tsx`).
  await page.addInitScript(() => {
    window.localStorage.setItem("dice-ifc.viewer.panel-width.left", "460");
  });
  await page.goto("/viewer");
  await expect(
    page.getByRole("heading", { name: "Viewer", level: 1 }),
  ).toBeVisible();

  await expect
    .poll(() => page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(460, 0);
});

test("opens more models than there are workers", async ({ page }, testInfo) => {
  // The parser pool has at most four workers, and each open model used to hold
  // one for as long as it was open: the fifth sat at "parsing" for ever. Seven
  // models, three of them the same file under another name, is more than any pool.
  const fixtures = path.resolve(__dirname, "../fixtures/ifc");
  const files = [
    "georeferenced-wall-ifc4.ifc",
    "bridge-ifc4x3.ifc",
    "clash-ifc4.ifc",
    "facets-ifc4.ifc",
    "spaces-ifc4.ifc",
  ].map((name) => path.join(fixtures, name));
  const copies = ["copy-a.ifc", "copy-b.ifc"].map((name) => {
    const copy = testInfo.outputPath(name);
    fs.copyFileSync(IFC4, copy);
    return copy;
  });

  await page.setInputFiles('input[type="file"]', [...files, ...copies]);

  await expect(page.locator("[data-rendered-models]")).toHaveAttribute("data-rendered-models", "7", {
    timeout: 90_000,
  });
});
