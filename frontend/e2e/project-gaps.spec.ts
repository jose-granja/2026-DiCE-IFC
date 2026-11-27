import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * What a project must keep that it once lost (AGENTS.md §8c-bis). Each test is
 * a full save → reload → restore.
 *
 * - The BCF topics and the IDS editor's document are in their stores only once
 *   their panel (or page) has loaded the draft kept on this device. A Save made
 *   after a reload, before that, left them out — and restoring it wrote an
 *   empty BCF draft over the user's. Saving now reads an untouched draft first.
 * - Filter ticks are put back after the isolation, and applied ticks clear an
 *   isolation that replaced the filter (`setFacetVisible`), so a session with
 *   both came back with the filter instead. Such ticks are now `dormant`.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const BCF = path.resolve(__dirname, "../fixtures/bcf/v3.0/labels.bcf");

const tab = (page: Page, value: string) => page.locator(`[role="tab"][id$="-trigger-${value}"]`);
const visible = (page: Page) => page.locator("[data-visible-entities]");
const contextMenu = (page: Page) => page.locator("[data-viewer-context-menu]");

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

async function openModel(page: Page) {
  await page.goto("/viewer?panel=models");
  await page.setInputFiles('input[type="file"]', [IFC]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
}

async function saveWorkspace(page: Page) {
  await page.locator("[data-workspace-save]").click();
  await expect(page.getByText(/^Session saved in this browser: 1 model/)).toBeVisible({ timeout: 30_000 });
}

async function restoreWorkspace(page: Page) {
  await page.reload();
  await page.locator("[data-workspace-restore]").click();
  await expect(page.getByText(/^Loaded the saved session: 1 model/)).toBeVisible({ timeout: 60_000 });
}

/** Right-click across the canvas until an element of `type` is under the pointer. */
async function rightClickAnElement(page: Page, type: RegExp) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
    for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: "right" });
      if (await contextMenu(page).isVisible().catch(() => false)) {
        if (type.test((await contextMenu(page).innerText()) ?? "")) return;
        await page.keyboard.press("Escape");
        await expect(contextMenu(page)).toHaveCount(0);
      }
    }
  }
  throw new Error(`No ${type} found under the pointer`);
}

test("Save keeps BCF topics that are in the saved draft though the BCF tab was not opened since a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The user's topics, saved as the draft on this device.
  await page.goto("/viewer?panel=bcf");
  await page.locator('input[accept*=".bcf"]').setInputFiles([BCF]);
  await expect(page.getByRole("status")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved on this device.")).toBeVisible();

  // A later visit: open a model and Save, without opening the BCF tab.
  await openModel(page);
  await saveWorkspace(page);
  expect.soft(await workspaceFiles(page), "the project should carry the draft's topics").toContain("bcf/topics.bcf");

  // Restoring that save must not cost the user their topics.
  await restoreWorkspace(page);
  await tab(page, "bcf").click();
  await expect(page.getByText("Labels", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("Save keeps the IDS editor's saved document though the editor was not opened since a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/ids/create");
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved on this device.")).toBeVisible();

  // A full navigation: the viewer starts with an empty IDS store.
  await openModel(page);
  await saveWorkspace(page);
  expect(await workspaceFiles(page)).toContain("ids/editor.ids");
});

test("a filter tick and an isolation made after it come back as they were", async ({ page }) => {
  test.setTimeout(120_000);
  await openModel(page);

  // Filter to the two walls…
  await tab(page, "classes").click();
  const classes = page.locator('[data-facet="classes"]');
  const header = classes.getByRole("button").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await classes.getByLabel("IfcWall", { exact: true }).click();
  await expect(visible(page)).toHaveAttribute("data-visible-entities", "2/3");

  // …then isolate one of them from the viewport's menu.
  await rightClickAnElement(page, /IfcWall/);
  await contextMenu(page).getByRole("menuitem", { name: "Isolate selected" }).click();
  await expect(visible(page)).toHaveAttribute("data-visible-entities", "1/3");

  await saveWorkspace(page);
  await restoreWorkspace(page);
  await expect(tab(page, "classes")).toHaveAttribute("data-filter-active", "true");

  // The filter resolves after the restore returns (FacetFilterSync), so the
  // view has to hold, not merely pass through, what was saved.
  for (let i = 0; i < 10; i += 1) {
    await expect(visible(page)).toHaveAttribute("data-visible-entities", "1/3");
    await page.waitForTimeout(300);
  }
});
