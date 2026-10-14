import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Save and Restore: the whole session kept in this browser, through the same
 * project the "Project" menu writes to a folder.
 *
 * Every restore here happens after a reload, so the models are gone from
 * memory and what comes back can only have come from what Save kept.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const CLOUD = path.resolve(__dirname, "../fixtures/pointcloud/patch.ply");

const empty = {
  classes: [],
  names: [],
  predefinedTypes: [],
  objectTypes: [],
  materials: [],
  materialCategories: [],
  properties: [],
};
const MATRIX = {
  groups: [
    { id: "g-walls", name: "Kept walls group", filter: { ...empty, classes: ["IfcWall*"] } },
    { id: "g-slabs", name: "Kept slabs group", filter: { ...empty, classes: ["IfcSlab*"] } },
  ],
  tolerances: [{ id: "t", name: "Hard", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0 }],
  rules: [{ a: "g-walls", b: "g-slabs", toleranceId: "t" }],
};
const QUANTITIES = [
  {
    id: "q-1",
    code: "13.01",
    description: "Kept wall count",
    query: {
      filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
      sources: [{ id: "s", alias: "count", kind: "count" }],
    },
  },
];

test.describe.configure({ mode: "serial" });

const tab = (page: Page, value: string) => page.locator(`[role="tab"][id$="-trigger-${value}"]`);

/** Files under the saved workspace, as paths. */
async function workspaceFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const list = async (dir: FileSystemDirectoryHandle, prefix = ""): Promise<string[]> => {
      const out: string[] = [];
      for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind === "directory") out.push(...(await list(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
        else out.push(`${prefix}${name}`);
      }
      return out;
    };
    const root = await navigator.storage.getDirectory();
    try {
      const project = await (await root.getDirectoryHandle("workspaces")).getDirectoryHandle("project");
      return (await list(project)).sort();
    } catch {
      return [];
    }
  });
}

test("Save keeps the whole session in this browser, and Restore brings all of it back", async ({ page }) => {
  test.setTimeout(120_000);
  // Seeded once: after the save these are changed, so that what the restore
  // shows can only be what was saved.
  await page.addInitScript(
    ({ matrix, quantities }) => {
      if (window.sessionStorage.getItem("seeded")) return;
      window.sessionStorage.setItem("seeded", "1");
      window.localStorage.setItem("dice-ifc.clash-matrix.v1", JSON.stringify(matrix));
      window.localStorage.setItem("dice-ifc.quantity-query-list.v1", JSON.stringify(quantities));
    },
    { matrix: MATRIX, quantities: QUANTITIES },
  );
  await page.goto("/viewer?panel=models");
  await expect(page.locator("[data-workspace-save]")).toBeDisabled();

  await page.setInputFiles('input[type="file"]', [IFC, CLOUD]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Hide patch.ply" })).toBeVisible({ timeout: 60_000 });

  // What the old Save never kept: a hidden model, a point cloud's size, a
  // section plane moved off its default, the filter ticks, the open tab.
  await page.getByRole("button", { name: "Hide facets-ifc4.ifc" }).click();
  const pointSize = page.getByRole("slider", { name: "Point size" });
  await pointSize.focus();
  await pointSize.press("ArrowRight");
  const savedPointSize = await pointSize.getAttribute("aria-valuenow");
  await tab(page, "classes").click();
  const materials = page.locator('[data-facet="materials"]');
  const header = materials.getByRole("button").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await materials.getByLabel("Timber CLT", { exact: true }).click();
  await tab(page, "section").click();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  const plane = page.getByRole("slider", { name: "Plan position" });
  await plane.focus();
  for (let i = 0; i < 4; i += 1) await plane.press("ArrowRight");
  const savedPosition = await plane.getAttribute("aria-valuenow");

  await page.locator("[data-workspace-save]").click();
  await expect(page.getByText(/^Session saved in this browser: 1 model, 1 point cloud/)).toBeVisible({
    timeout: 30_000,
  });
  // Files opened without a reusable handle are copied in, as a project folder.
  expect(await workspaceFiles(page)).toEqual(
    expect.arrayContaining([
      "project.json",
      "models/facets-ifc4.ifc",
      "pointclouds/patch.ply",
      "quantities/quantities.xlsx",
      "clash/clash-matrix.xlsx",
    ]),
  );

  // Change what the browser remembers on its own, then start over.
  await page.evaluate(() => {
    window.localStorage.removeItem("dice-ifc.clash-matrix.v1");
    window.localStorage.removeItem("dice-ifc.quantity-query-list.v1");
  });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);

  const restore = page.locator("[data-workspace-restore]");
  await expect(restore).toBeEnabled();
  await restore.click();
  // Nothing was open, so there is nothing to confirm replacing.
  await expect(page.getByText(/^Loaded the saved session: 1 model, 1 point cloud\.$/)).toBeVisible({
    timeout: 60_000,
  });

  await expect(tab(page, "section")).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("slider", { name: "Plan position" })).toHaveAttribute("aria-valuenow", savedPosition!);
  await expect(tab(page, "classes")).toHaveAttribute("data-filter-active", "true");
  await tab(page, "models").click();
  await expect(page.getByRole("button", { name: "Show facets-ifc4.ifc" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Point size" })).toHaveAttribute("aria-valuenow", savedPointSize!);
  await tab(page, "quantities").click();
  await expect(page.locator('[data-query-list] [role="listitem"]')).toContainText("Kept wall count");
  await tab(page, "clash").click();
  await expect(page.locator('input[value="Kept slabs group"]')).toBeVisible();

  // Restoring over an open session asks first, as loading a project folder does.
  await page.locator("[data-workspace-restore]").click();
  await expect(page.locator("[data-project-confirm]")).toContainText("Load the project?");
});

test("a model opened through the file picker is kept as a reference, not a copy", async ({ page }) => {
  test.setTimeout(120_000);
  const bytes = [...(await readFile(IFC))];
  // Playwright cannot drive the native picker; hand back a real file handle —
  // one in the origin-private file system — as Chromium's picker would.
  await page.addInitScript((data) => {
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        const picked = await root.getDirectoryHandle("picked-files", { create: true });
        const handle = await picked.getFileHandle("facets-ifc4.ifc", { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();
        return [handle];
      },
    });
  }, bytes);
  await page.goto("/viewer?panel=models");
  await page.getByRole("button", { name: "Add models" }).click();
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await page.locator("[data-workspace-save]").click();
  await expect(page.getByText(/^Session saved in this browser: 1 model/)).toBeVisible({ timeout: 30_000 });
  const files = await workspaceFiles(page);
  expect(files).toContain("project.json");
  // The handle stands in for the file: nothing was copied.
  expect(files.filter((file) => file.startsWith("models/"))).toEqual([]);

  await page.reload();
  await page.locator("[data-workspace-restore]").click();
  await expect(page.getByText(/^Loaded the saved session: 1 model, no point clouds\.$/)).toBeVisible({
    timeout: 60_000,
  });
  await tab(page, "models").click();
  await expect(page.getByRole("button", { name: "Close facets-ifc4.ifc" })).toBeVisible();
});

test("restores a session saved by the previous version of Save", async ({ page }) => {
  const bytes = [...(await readFile(IFC))];
  await page.goto("/viewer?panel=models");
  // What the first Save wrote: a JSON of models and a camera in OPFS, and the
  // models' file handles in IndexedDB.
  await page.evaluate(async (data) => {
    const root = await navigator.storage.getDirectory();
    const picked = await root.getDirectoryHandle("picked-files", { create: true });
    const handle = await picked.getFileHandle("legacy.ifc", { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(data));
    await writable.close();

    await (await root.getDirectoryHandle("workspaces", { create: true }))
      .removeEntry("project", { recursive: true })
      .catch(() => undefined);
    const workspaces = await root.getDirectoryHandle("workspaces", { create: true });
    const json = await workspaces.getFileHandle("current", { create: true });
    const out = await json.createWritable();
    await out.write(
      JSON.stringify({
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        models: [{ handleKey: "0:legacy.ifc", name: "legacy.ifc", colour: "#d97706", visible: false }],
        camera: { position: [10, 10, 10], target: [0, 0, 0] },
      }),
    );
    await out.close();

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("dice-ifc-workspace", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("file-handles");
      request.onsuccess = () => {
        const db = request.result;
        const put = db.transaction("file-handles", "readwrite").objectStore("file-handles").put(handle, "0:legacy.ifc");
        put.onsuccess = () => {
          db.close();
          resolve();
        };
        put.onerror = () => reject(put.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, bytes);
  await page.reload();

  await page.locator("[data-workspace-restore]").click();
  await expect(page.getByText(/^Loaded the saved session: 1 model, no point clouds\.$/)).toBeVisible({
    timeout: 60_000,
  });
  await tab(page, "models").click();
  // Its visibility came back with it.
  await expect(page.getByRole("button", { name: "Show legacy.ifc" })).toBeVisible();
});
