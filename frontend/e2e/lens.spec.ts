import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

/**
 * Lenses, as on ifclite.com: saved ways of looking at the model. The fixture
 * has two walls and a slab across two storeys and two materials.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const tab = (page: Page, value: string) => page.locator(`[role="tab"][id$="-trigger-${value}"]`);
const scene = (page: Page) => page.locator("[data-rendered-models]");
const legend = (page: Page) => page.locator("[data-lens-legend]").first();

async function open(page: Page) {
  await page.goto("/viewer?panel=lens");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.locator("[data-lens-panel]")).toBeVisible();
}

/** Make and save an auto-colour lens by storey. */
async function makeFloorsLens(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Auto-colour lens" }).click();
  const editor = page.locator("[data-lens-editor]");
  await editor.getByLabel("Name", { exact: true }).fill("Floors");
  await editor.getByRole("combobox", { name: "Colour by" }).click();
  await page.getByRole("option", { name: "Storey" }).click();
  await editor.getByRole("button", { name: "Save lens" }).click();
}

async function count(page: Page, label: string) {
  return legend(page).locator(`[data-lens-legend-entry="${label}"] [data-lens-legend-count]`);
}

test("a built-in lens colours by class, with a legend, and stays on in other tabs", async ({ page }) => {
  await open(page);
  await page.locator('[data-lens="By IFC class"]').click();

  await expect(await count(page, "IfcWall")).toHaveText("2");
  await expect(await count(page, "IfcSlab")).toHaveText("1");
  await expect(page.locator('[data-lens="By IFC class"]')).toHaveAttribute("aria-pressed", "true");

  // On while another panel is used, and the tab says so.
  await tab(page, "models").click();
  await expect(tab(page, "lens")).toHaveAttribute("data-lens-active", "true");

  // Off again from the legend.
  await tab(page, "lens").click();
  await legend(page).getByRole("button", { name: "Turn off" }).click();
  await expect(tab(page, "lens")).not.toHaveAttribute("data-lens-active", "true");
  await expect(page.locator("[data-lens-legend]")).toHaveCount(0);
});

test("a legend entry can be switched off, hiding its elements", async ({ page }) => {
  await open(page);
  await page.locator('[data-lens="By IFC class"]').click();
  await expect(await count(page, "IfcWall")).toHaveText("2");
  await expect(scene(page)).toHaveAttribute("data-visible-entities", "3/3");

  await legend(page).getByRole("button", { name: "Hide IfcWall" }).click();
  await expect(scene(page)).toHaveAttribute("data-visible-entities", "1/3");
  await legend(page).getByRole("button", { name: "Show IfcWall" }).click();
  await expect(scene(page)).toHaveAttribute("data-visible-entities", "3/3");
});

test("a rules lens is built, previewed while edited, ghosts the rest, and is saved", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Lens with rules" }).click();

  const editor = page.locator("[data-lens-editor]");
  await editor.getByLabel("Name", { exact: true }).fill("Slabs only");
  const rule = editor.locator("[data-lens-rule]").first();
  await rule.getByLabel("Rule name").fill("Slabs");
  await rule.getByRole("button", { name: "Edit filter" }).click();
  const classes = rule.getByLabel("IFC class");
  await classes.fill("IfcSlab");
  await classes.press("Enter");

  // Previewed as it is edited: the slab coloured, the walls ghosted.
  await expect(await count(page, "Slabs")).toHaveText("1");
  await expect(await count(page, "Everything else (ghosted)")).toHaveText("2");
  await expect(scene(page)).toHaveAttribute("data-translucent-entities", "2");

  await editor.getByRole("button", { name: "Save lens" }).click();
  const saved = page.locator('[data-lens-list="saved"] [data-lens="Slabs only"]');
  await expect(saved).toHaveAttribute("aria-pressed", "true");

  // Kept by this browser.
  await page.reload();
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('[data-lens-list="saved"] [data-lens="Slabs only"]')).toHaveAttribute("aria-pressed", "true");
  await expect(scene(page)).toHaveAttribute("data-translucent-entities", "2");
});

test("a rule can hide what it matches, and the rest can be left as it is", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Lens with rules" }).click();
  const editor = page.locator("[data-lens-editor]");
  const rule = editor.locator("[data-lens-rule]").first();
  await rule.getByRole("button", { name: "Edit filter" }).click();
  const classes = rule.getByLabel("IFC class");
  await classes.fill("IfcWall*");
  await classes.press("Enter");
  await rule.getByRole("combobox", { name: /^What .* does$/ }).click();
  await page.getByRole("option", { name: "Hide" }).click();
  await editor.getByRole("combobox", { name: "Elements no rule matches" }).click();
  await page.getByRole("option", { name: "Leave them as they are" }).click();

  await expect(scene(page)).toHaveAttribute("data-visible-entities", "1/3");
  await expect(scene(page)).toHaveAttribute("data-translucent-entities", "0");

  // Cancelling the edit takes its preview away.
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(scene(page)).toHaveAttribute("data-visible-entities", "3/3");
});

test("an auto-colour lens colours by storey", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Auto-colour lens" }).click();
  const editor = page.locator("[data-lens-editor]");
  await editor.getByRole("combobox", { name: "Colour by" }).click();
  await page.getByRole("option", { name: "Storey" }).click();
  const entries = editor.locator("[data-lens-legend] [data-lens-legend-count]");
  await expect(entries).toHaveCount(2);
  const counts = (await entries.allTextContents()).map(Number);
  expect(counts.reduce((total, value) => total + value, 0)).toBe(3);
});

test("lenses travel with the session: Save, then Restore in a browser that forgot them", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Auto-colour lens" }).click();
  const editor = page.locator("[data-lens-editor]");
  await editor.getByLabel("Name", { exact: true }).fill("Floors");
  await editor.getByRole("combobox", { name: "Colour by" }).click();
  await page.getByRole("option", { name: "Storey" }).click();
  await editor.getByRole("button", { name: "Save lens" }).click();

  await page.locator("[data-workspace-save]").click();
  await expect(page.getByText(/^Session saved in this browser/)).toBeVisible({ timeout: 30_000 });

  // The browser's own list goes; only the saved session still has the lens.
  await page.evaluate(() => window.localStorage.removeItem("dice-ifc.lenses.v1"));
  await page.reload();
  await expect(page.locator('[data-lens="Floors"]')).toHaveCount(0);

  await page.locator("[data-workspace-restore]").click();
  await expect(page.getByText(/^Loaded the saved session/)).toBeVisible({ timeout: 60_000 });
  await tab(page, "lens").click();
  await expect(page.locator('[data-lens-list="saved"] [data-lens="Floors"]')).toHaveAttribute("aria-pressed", "true");
  await expect(legend(page).locator("[data-lens-legend-count]")).toHaveCount(2);
});

test("a list of lenses is downloaded, and uploaded into a browser that has none", async ({ page }, testInfo) => {
  await open(page);
  // Nothing of the user's own yet: nothing to download.
  await expect(page.locator("[data-lens-download]")).toBeDisabled();
  await makeFloorsLens(page);

  const downloading = page.waitForEvent("download");
  await page.locator("[data-lens-download]").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("dice-ifc-lenses.json");
  const listPath = testInfo.outputPath("lenses.json");
  await download.saveAs(listPath);
  const list = JSON.parse(await readFile(listPath, "utf8"));
  expect(list).toMatchObject({ format: "dice-ifc-lenses", version: 1 });
  // The user's own lens, and none of the built-ins every copy already has.
  expect(list.lenses).toEqual([expect.objectContaining({ name: "Floors", kind: "auto", source: { kind: "storey" } })]);

  await page.evaluate(() => window.localStorage.removeItem("dice-ifc.lenses.v1"));
  await page.reload();
  await expect(page.locator('[data-lens="Floors"]')).toHaveCount(0);

  await page.locator("[data-lens-upload-input]").setInputFiles(listPath);
  await expect(page.getByText("1 lens added to Saved.")).toBeVisible();
  const floors = page.locator('[data-lens-list="saved"] [data-lens="Floors"]');
  await expect(floors).toHaveCount(1);
  // Uploading the same list again updates it rather than doubling it.
  await page.locator("[data-lens-upload-input]").setInputFiles(listPath);
  await expect(floors).toHaveCount(1);

  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await floors.click();
  await expect(legend(page).locator("[data-lens-legend-count]")).toHaveCount(2);
});

test("a file that is not a lens list is refused, and the library left alone", async ({ page }) => {
  await open(page);
  await makeFloorsLens(page);
  await page.locator("[data-lens-upload-input]").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "dice-ifc-project", version: 1 })),
  });
  await expect(page.getByText(/project\.json is not a DiCE-IFC lens list/)).toBeVisible();
  await expect(page.locator('[data-lens-list="saved"] [data-lens]')).toHaveCount(1);
});

test("a saved project keeps its lenses as a lens list beside project.json", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ acceptDownloads: true, locale: "en-US" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
  });
  await open(page);
  await makeFloorsLens(page);

  await page.locator("[data-project-menu]").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save project (.zip)…" }).click();
  const zipPath = testInfo.outputPath("project.zip");
  await (await downloading).saveAs(zipPath);
  await context.close();

  const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
  const name = (suffix: string) => Object.keys(entries).find((entry) => entry.endsWith(suffix))!;
  const manifest = JSON.parse(new TextDecoder().decode(entries[name("/project.json")]));
  expect(manifest.lenses).toEqual({ path: "lenses/lenses.json", activeId: expect.stringMatching(/^lens-/) });
  const list = JSON.parse(new TextDecoder().decode(entries[name("/lenses/lenses.json")]));
  expect(list.format).toBe("dice-ifc-lenses");
  expect(list.lenses.map((lens: { name: string }) => lens.name)).toEqual(["Floors"]);
});
