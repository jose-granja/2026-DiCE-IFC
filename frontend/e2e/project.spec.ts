import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

/**
 * Saving the viewer as a project folder and opening it again.
 *
 * The load half always runs in a fresh browser context — empty localStorage,
 * empty OPFS — so whatever comes back can only have come from the folder.
 */

const IFC = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const CLOUD = path.resolve(__dirname, "../fixtures/pointcloud/patch.ply");
const IDS = path.resolve(__dirname, "../fixtures/ids/wall-fire-rating.ids");
const BCF = path.resolve(__dirname, "../fixtures/bcf/v3.0/labels.bcf");

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
    { id: "g-walls", name: "Seeded walls group", filter: { ...empty, classes: ["IfcWall*"] } },
    { id: "g-slabs", name: "Seeded slabs group", filter: { ...empty, classes: ["IfcSlab*"] } },
  ],
  tolerances: [{ id: "t", name: "Hard", mode: "hard", horizontal: 0.01, vertical: 0.01, clearance: 0 }],
  rules: [{ a: "g-walls", b: "g-slabs", toleranceId: "t" }],
};
const QUANTITIES = [
  {
    id: "q-1",
    code: "13.01",
    description: "Seeded wall count",
    query: {
      filters: { classes: ["IfcWall"], predefinedTypes: [], objectTypes: [], materials: [], properties: [] },
      sources: [{ id: "s", alias: "count", kind: "count" }],
    },
  },
];

test.describe.configure({ mode: "serial" });

const tab = (page: Page, value: string) => page.locator(`[role="tab"][id$="-trigger-${value}"]`);

async function openWithFiles(page: Page) {
  await page.goto("/viewer?panel=models");
  await page.setInputFiles('input[type="file"]', [IFC, CLOUD]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Hide patch.ply" })).toBeVisible({ timeout: 60_000 });
}

/** Unpack a downloaded project .zip into a real folder on disk, as a user would. */
async function unpack(zipPath: string): Promise<{ dir: string; entries: Record<string, Uint8Array> }> {
  const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
  const dir = await mkdtemp(path.join(tmpdir(), "dice-project-"));
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), bytes);
  }
  return { dir, entries };
}

test("saves the session and brings all of it back in a fresh browser, from the .zip and from the folder", async ({
  browser,
}, testInfo) => {
  // Two browsers and three full loads: well past the default budget when the
  // whole suite is running in parallel.
  test.setTimeout(120_000);

  // ---- set a session up
  const saving = await browser.newContext({ acceptDownloads: true, locale: "en-US" });
  const page = await saving.newPage();
  await page.addInitScript(
    ({ matrix, quantities }) => {
      // Firefox and Safari have no folder picker; that is the .zip path.
      Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
      window.localStorage.setItem("dice-ifc.clash-matrix.v1", JSON.stringify(matrix));
      window.localStorage.setItem("dice-ifc.quantity-query-list.v1", JSON.stringify(quantities));
    },
    { matrix: MATRIX, quantities: QUANTITIES },
  );
  await openWithFiles(page);

  // A hidden model and a bigger point size.
  await page.getByRole("button", { name: "Hide facets-ifc4.ifc" }).click();
  await expect(page.getByRole("button", { name: "Show facets-ifc4.ifc" })).toBeVisible();
  const pointSize = page.getByRole("slider", { name: "Point size" });
  await pointSize.focus();
  await pointSize.press("ArrowRight");
  await pointSize.press("ArrowRight");
  const savedPointSize = await pointSize.getAttribute("aria-valuenow");

  // An IDS to validate and some BCF topics.
  await tab(page, "ids").click();
  await page.locator('input[accept*=".ids"]').setInputFiles(IDS);
  await expect(page.getByText("wall-fire-rating").first()).toBeVisible();
  await tab(page, "bcf").click();
  await page.locator('input[accept*=".bcf"]').setInputFiles(BCF);
  const topicCount = page.getByText(/^\d+ topics?$/).first();
  await expect(topicCount).toBeVisible();
  const savedTopics = await topicCount.textContent();
  await page.getByRole("button", { name: "Show 3D markers" }).click();
  await expect(page.getByRole("button", { name: "Hide 3D markers" })).toHaveAttribute("aria-pressed", "true");

  // A section plane, moved off its default — and the tab left open on it.
  await tab(page, "section").click();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  const plane = page.getByRole("slider", { name: "Plan position" });
  await plane.focus();
  for (let i = 0; i < 5; i += 1) await plane.press("ArrowRight");
  const savedPosition = await plane.getAttribute("aria-valuenow");

  // ---- save
  await page.locator("[data-project-menu]").click();
  await expect(page.getByText(/downloaded as a \.zip/)).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save project (.zip)…" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^DiCE-IFC project \d{4}-\d{2}-\d{2} \d{4}\.zip$/);
  const zipPath = testInfo.outputPath("project.zip");
  await download.saveAs(zipPath);
  await saving.close();

  // ---- what is in the folder
  const { dir, entries } = await unpack(zipPath);
  const root = download.suggestedFilename().replace(/\.zip$/, "");
  expect(Object.keys(entries).sort()).toEqual(
    [
      "bcf/topics.bcf",
      "clash/clash-matrix.xlsx",
      "ids/wall-fire-rating.ids",
      "models/facets-ifc4.ifc",
      "pointclouds/patch.ply",
      "project.json",
      "quantities/quantities.xlsx",
    ].map((file) => `${root}/${file}`),
  );
  // The model is the file that was opened, byte for byte.
  expect(Buffer.from(entries[`${root}/models/facets-ifc4.ifc`]).equals(await readFile(IFC))).toBe(true);
  const manifest = JSON.parse(new TextDecoder().decode(entries[`${root}/project.json`]));
  expect(manifest).toMatchObject({
    format: "dice-ifc-project",
    models: [{ name: "facets-ifc4.ifc", path: "models/facets-ifc4.ifc", visible: false }],
    pointClouds: [{ name: "patch.ply", size: Number(savedPointSize) }],
    viewer: { panel: "section" },
    bcf: { path: "bcf/topics.bcf", markersVisible: true },
  });
  expect(manifest.sectionPlanes).toHaveLength(1);
  expect(manifest.sectionPlanes[0].position).toBeCloseTo(Number(savedPosition), 6);
  // The quantity list and the clash matrix are workbooks; the JSON only points at them.
  expect(manifest.quantities).toEqual({ path: "quantities/quantities.xlsx" });
  expect(manifest.clash).toEqual({ path: "clash/clash-matrix.xlsx" });
  const sheetText = (workbook: Uint8Array) =>
    Object.entries(unzipSync(workbook))
      .filter(([name]) => name.startsWith("xl/worksheets/"))
      .map(([, bytes]) => new TextDecoder().decode(bytes))
      .join("\n");
  expect(sheetText(entries[`${root}/quantities/quantities.xlsx`])).toContain("Seeded wall count");
  expect(sheetText(entries[`${root}/clash/clash-matrix.xlsx`])).toContain("Seeded slabs group");
  expect(manifest.viewer.camera.position).toHaveLength(3);

  // ---- load the .zip in a fresh browser
  const loading = await browser.newContext({ locale: "en-US" });
  const fresh = await loading.newPage();
  const errors: string[] = [];
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto("/viewer");
  // Nothing is open, so there is nothing to confirm replacing.
  await fresh.locator("[data-project-zip-input]").setInputFiles(zipPath);
  await expect(fresh.getByText(/^Loaded .*: 1 model, 1 point cloud\.$/)).toBeVisible({ timeout: 60_000 });

  const expectRestored = async (target: Page) => {
    // The tab that was open, with the plane where it was left.
    await expect(tab(target, "section")).toHaveAttribute("data-state", "active");
    await expect(target.getByRole("slider", { name: "Plan position" })).toHaveAttribute(
      "aria-valuenow",
      savedPosition!,
    );

    await tab(target, "models").click();
    await expect(target.getByRole("button", { name: "Show facets-ifc4.ifc" })).toBeVisible();
    await expect(target.getByRole("button", { name: "Close facets-ifc4.ifc" })).toHaveCount(1);
    await expect(target.getByRole("slider", { name: "Point size" })).toHaveAttribute(
      "aria-valuenow",
      savedPointSize!,
    );

    await tab(target, "quantities").click();
    await expect(target.locator('[data-query-list] [role="listitem"]')).toContainText("Seeded wall count");

    await tab(target, "clash").click();
    await expect(target.locator('input[value="Seeded walls group"]')).toBeVisible();
    await expect(target.locator('input[value="Seeded slabs group"]')).toBeVisible();

    await tab(target, "ids").click();
    await expect(target.getByText("wall-fire-rating").first()).toBeVisible();

    await tab(target, "bcf").click();
    await expect(target.getByText(savedTopics!, { exact: true }).first()).toBeVisible();
    await expect(target.getByRole("button", { name: "Hide 3D markers" })).toHaveAttribute("aria-pressed", "true");
  };
  await expectRestored(fresh);

  // ---- and the unpacked folder, over a session that is now open
  await tab(fresh, "section").click();
  await fresh.locator("[data-project-folder-input]").setInputFiles(path.join(dir, root));
  const confirm = fresh.locator("[data-project-confirm]");
  await expect(confirm).toContainText("Load the project?");
  await confirm.getByRole("button", { name: "Load project" }).click();
  await expect(fresh.getByText(/^Loaded .*: 1 model, 1 point cloud\.$/).first()).toBeVisible({
    timeout: 60_000,
  });
  // Replaced, not added to: still one model, and everything as saved.
  await expectRestored(fresh);
  expect(errors).toEqual([]);
  await loading.close();
});

test("writes a real folder where the browser can, and never over an earlier one", async ({ page }) => {
  // Playwright cannot drive the native folder picker; hand back a folder in the
  // origin-private file system instead, which supports the same writes.
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("picked", { create: true });
      },
    });
  });
  await openWithFiles(page);

  const save = async () => {
    await page.locator("[data-project-menu]").click();
    await page.getByRole("menuitem", { name: "Save project folder…" }).click();
    await expect(page.getByText(/^Project saved in the folder/).last()).toBeVisible({ timeout: 30_000 });
  };
  await save();
  await save();

  const written = await page.evaluate(async () => {
    const list = async (dir: FileSystemDirectoryHandle, prefix = ""): Promise<string[]> => {
      const out: string[] = [];
      for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind === "directory") out.push(...(await list(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
        else out.push(`${prefix}${name}`);
      }
      return out;
    };
    const root = await navigator.storage.getDirectory();
    const picked = await root.getDirectoryHandle("picked");
    const files = (await list(picked)).sort();
    // Shortest first: the original name, then its " (2)".
    const folders = [...new Set(files.map((file) => file.split("/")[0]))].sort(
      (a, b) => a.length - b.length,
    );
    const manifest = await (
      await (await (await picked.getDirectoryHandle(folders[0])).getFileHandle("project.json")).getFile()
    ).text();
    return { files, folders, manifest };
  });

  // Two saves, two folders: the second never writes into the first.
  expect(written.folders).toHaveLength(2);
  expect(written.folders[1]).toBe(`${written.folders[0]} (2)`);
  for (const folder of written.folders) {
    expect(written.files).toEqual(
      expect.arrayContaining([
        `${folder}/project.json`,
        `${folder}/models/facets-ifc4.ifc`,
        `${folder}/pointclouds/patch.ply`,
      ]),
    );
  }
  expect(JSON.parse(written.manifest).models[0].name).toBe("facets-ifc4.ifc");
});

test("refuses a folder that is not a project, and keeps the session open", async ({ page }, testInfo) => {
  await openWithFiles(page);
  const notAProject = testInfo.outputPath("photos");
  await mkdir(notAProject, { recursive: true });
  await writeFile(path.join(notAProject, "readme.txt"), "not a project");

  await page.locator("[data-project-folder-input]").setInputFiles(notAProject);
  await expect(page.getByText(/There is no project\.json in that folder/)).toBeVisible();
  // Nothing was closed to make room for a project that never arrived.
  await expect(page.locator("[data-project-confirm]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hide facets-ifc4.ifc" })).toBeVisible();
});

test("refuses a project.json it cannot read before closing anything", async ({ page }, testInfo) => {
  await openWithFiles(page);
  const broken = testInfo.outputPath("broken");
  await mkdir(broken, { recursive: true });
  await writeFile(
    path.join(broken, "project.json"),
    JSON.stringify({ format: "dice-ifc-project", version: 1, savedAt: "x", models: [{ path: 5 }] }),
  );

  await page.locator("[data-project-folder-input]").setInputFiles(broken);
  // Refused at once: no question about replacing the session is asked for a
  // project that cannot be opened.
  await expect(page.getByText(/project\.json has a value this version cannot read \(models\.0\.path/)).toBeVisible();
  await expect(page.locator("[data-project-confirm]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hide facets-ifc4.ifc" })).toBeVisible();
});

/**
 * A project folder written by hand, for what the round trip above does not
 * reach through the UI: a context model (which has to be placed through the GIS
 * panel), a measurement, the filter panel's ticks and the display settings.
 */
test("restores the context model, measurements, filter ticks and display settings", async ({
  page,
}, testInfo) => {
  const folder = testInfo.outputPath("hand-written");
  await mkdir(path.join(folder, "models"), { recursive: true });
  await mkdir(path.join(folder, "context"), { recursive: true });
  await writeFile(
    path.join(folder, "models", "georeferenced-wall-ifc4.ifc"),
    await readFile(path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc")),
  );
  await writeFile(
    path.join(folder, "context", "two-blocks.gml"),
    await readFile(path.resolve(__dirname, "../fixtures/citygml/two-blocks.gml")),
  );
  await writeFile(
    path.join(folder, "project.json"),
    JSON.stringify({
      format: "dice-ifc-project",
      version: 1,
      savedAt: "2026-10-13T12:00:00Z",
      models: [{ path: "models/georeferenced-wall-ifc4.ifc", name: "georeferenced-wall-ifc4.ifc" }],
      // Clip off: the fixture blocks are not placed within 100 m of the wall.
      context: { path: "context/two-blocks.gml", name: "two-blocks.gml", clipEnabled: false },
      viewer: {
        panel: "classes",
        display: { lightIntensity: 1.5, exposure: 1, edgesOn: false, edgeWidth: 2 },
      },
      filters: { facets: { classes: ["IfcSlab"] } },
      measurements: { distances: [{ id: "d", start: [0, 0, 0], end: [3, 4, 0] }], angles: [], areas: [], volumes: [] },
    }),
  );

  await page.goto("/viewer");
  await page.locator("[data-project-folder-input]").setInputFiles(folder);
  await expect(page.getByText(/^Loaded .*: 1 model, no point clouds\.$/)).toBeVisible({ timeout: 60_000 });

  // The context model went through the GIS panel and is in the scene: two
  // LoD1 blocks, six faces each, two triangles a face.
  await expect(page.locator("[data-context-model='true']")).toHaveAttribute("data-context-triangles", "24");

  // The GIS detour ended on the tab that was saved, with its ticks applied.
  await expect(tab(page, "classes")).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("checkbox", { name: "IfcSlab" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "IfcWall" })).not.toBeChecked();

  // The GIS panel remembers the context model rather than offering to load one.
  await tab(page, "gis").click();
  await expect(page.getByRole("button", { name: "Remove the context model" })).toBeVisible();

  await tab(page, "measure").click();
  // Listed in the panel, and labelled in the viewport too.
  await expect(page.getByRole("button", { name: "Remove distance 1" })).toBeVisible();
  await expect(page.getByText("5.000 m", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "Open display settings" }).click();
  await expect(page.getByRole("slider", { name: "Light intensity" })).toHaveAttribute("aria-valuenow", "1.5");
  await expect(page.getByRole("switch", { name: "Show edges" })).not.toBeChecked();
});


test("keeps an element filter that was set before switching to another tab", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const saving = await browser.newContext({ acceptDownloads: true, locale: "en-US" });
  const page = await saving.newPage();
  await page.addInitScript(() =>
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }),
  );
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await tab(page, "classes").click();
  const materials = page.locator('[data-facet="materials"]');
  const header = materials.getByRole("button").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await materials.getByLabel("Timber CLT", { exact: true }).click();
  const visible = (target: Page) => target.locator("[data-visible-entities]");
  await expect(visible(page)).toHaveAttribute("data-visible-entities", "1/3");
  // Saved from another tab: the filter has to have outlived the panel.
  await tab(page, "gis").click();
  await expect(visible(page)).toHaveAttribute("data-visible-entities", "1/3");

  await page.locator("[data-project-menu]").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save project (.zip)…" }).click();
  const zipPath = testInfo.outputPath("filtered.zip");
  await (await downloading).saveAs(zipPath);
  await saving.close();

  const loading = await browser.newContext({ locale: "en-US" });
  const fresh = await loading.newPage();
  await fresh.goto("/viewer");
  await fresh.locator("[data-project-zip-input]").setInputFiles(zipPath);
  await expect(fresh.getByText(/^Loaded /)).toBeVisible({ timeout: 60_000 });
  await expect(tab(fresh, "gis")).toHaveAttribute("data-state", "active");
  await expect(visible(fresh)).toHaveAttribute("data-visible-entities", "1/3");
  await expect(tab(fresh, "classes")).toHaveAttribute("data-filter-active", "true");
  await loading.close();
});

/** A project that had the 3D world context on, written by hand. */
async function globeProject(dir: string, globe: Record<string, unknown>) {
  await mkdir(path.join(dir, "models"), { recursive: true });
  await writeFile(
    path.join(dir, "models", "georeferenced-wall-ifc4.ifc"),
    await readFile(path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc")),
  );
  await writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({
      format: "dice-ifc-project",
      version: 1,
      savedAt: "2026-10-13T12:00:00Z",
      models: [{ path: "models/georeferenced-wall-ifc4.ifc", name: "georeferenced-wall-ifc4.ifc" }],
      viewer: { panel: "section", globe },
    }),
  );
}

test("asks before a project turns the 3D world context on, naming who gets the location", async ({
  page,
}, testInfo) => {
  const dir = testInfo.outputPath("globe-project");
  await globeProject(dir, { on: true, layer: "google-photorealistic" });
  await page.goto("/viewer");

  // Asked even with nothing open: this is a third party, not a replaced session.
  await page.locator("[data-project-folder-input]").setInputFiles(dir);
  const consent = page.locator("[data-project-globe-consent]");
  await expect(consent).toContainText("Google Photorealistic 3D");
  await expect(consent).toContainText("Google, through Cesium ion, which receives the location of the building");
  await expect(consent.getByRole("checkbox")).toBeChecked();

  // Declined: the project loads and nothing is turned on.
  await consent.getByRole("checkbox").click();
  await page.locator("[data-project-confirm]").getByRole("button", { name: "Load project" }).click();
  await expect(page.getByText(/^Loaded /)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/3D world context could not be turned on/)).toHaveCount(0);
  await expect(tab(page, "gis")).not.toHaveAttribute("data-globe-active", "true");
  // The layer choice came back all the same, for when the user turns it on.
  await tab(page, "gis").click();
  await expect(page.locator("[data-globe-controls]")).toBeVisible();
});

test("a project that only had the 3D world context off asks nothing", async ({ page }, testInfo) => {
  const dir = testInfo.outputPath("globe-off");
  await globeProject(dir, { on: false, layer: "osm-buildings" });
  await page.goto("/viewer");
  await page.locator("[data-project-folder-input]").setInputFiles(dir);
  await expect(page.getByText(/^Loaded /)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-project-confirm]")).toHaveCount(0);
});

test.describe("with a Cesium ion token", () => {
  test.skip(!process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN, "no Cesium ion token configured, so there is no globe");

  test("the 3D world context stays on across tabs, and a project turns it back on", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const saving = await browser.newContext({ acceptDownloads: true, locale: "en-US" });
    const page = await saving.newPage();
    await page.addInitScript(() =>
      Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }),
    );
    await page.goto("/viewer");
    await page.setInputFiles('input[type="file"]', [path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc")]);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 120_000 });

    await tab(page, "gis").click();
    await page.getByLabel("3D world context").click({ force: true });
    await expect(page.locator("[data-depth-proxy]")).toBeAttached({ timeout: 90_000 });

    // Another tab: the globe is still there, and the GIS tab says so.
    await tab(page, "section").click();
    await expect(tab(page, "gis")).toHaveAttribute("data-globe-active", "true");
    await expect(page.locator("[data-depth-proxy]")).toBeAttached();

    await page.locator("[data-project-menu]").click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Save project (.zip)…" }).click();
    const zipPath = testInfo.outputPath("globe.zip");
    await (await downloading).saveAs(zipPath);
    await saving.close();

    const loading = await browser.newContext({ locale: "en-US" });
    const fresh = await loading.newPage();
    await fresh.goto("/viewer");
    await fresh.locator("[data-project-zip-input]").setInputFiles(zipPath);
    await expect(fresh.locator("[data-project-globe-consent]")).toContainText("Cesium ion");
    await fresh.locator("[data-project-confirm]").getByRole("button", { name: "Load project" }).click();
    await expect(fresh.getByText(/^Loaded /)).toBeVisible({ timeout: 120_000 });

    // Back on the saved tab, with the globe on behind it.
    await expect(tab(fresh, "section")).toHaveAttribute("data-state", "active");
    await expect(tab(fresh, "gis")).toHaveAttribute("data-globe-active", "true");
    await expect(fresh.locator("[data-depth-proxy]")).toBeAttached({ timeout: 90_000 });
    await tab(fresh, "gis").click();
    await expect(fresh.getByLabel("3D world context")).toBeChecked();
    await loading.close();
  });
});
