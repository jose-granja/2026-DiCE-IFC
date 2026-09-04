import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * IDS validation, end to end.
 *
 * Vitest covers the engine call, the aggregation and the BCF export against
 * real fixtures. What only a browser shows is the whole chain wired together:
 * models loaded in the viewer, validation running in the worker pool without
 * freezing the page, the failure jumping back into the 3D view, and the two
 * exports actually downloading.
 *
 * Navigation is in-app throughout. `page.goto()` is a full reload, which drops
 * the viewer's models — and then there is nothing to validate.
 *
 * Validation lives in the viewer's IDS tab rather than on its own page: the
 * useful action on a failure is "show me that element", which needs the
 * viewport. `/ids/validate` redirects here.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");
const IDS = path.resolve(__dirname, "../fixtures/ids/wall-fire-rating.ids");
const IDS_PASS = path.resolve(__dirname, "../fixtures/ids/all-pass.ids");

/** Load a model, then open the IDS panel the way a user would. */
async function openWithModel(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("tab", { name: "IDS" }).click();
  await expect(page.getByRole("button", { name: /Load \.ids/ })).toBeVisible();
}

async function runValidation(page: Page, ids = IDS) {
  // The panel's own hidden input, not the viewer's model picker.
  await page.locator('input[accept*=".ids"]').setInputFiles(ids);
  await page.getByRole("button", { name: /^Validate/ }).click();
  await expect(page.getByRole("status").first()).toBeVisible({ timeout: 60_000 });
}

test("the old page redirects to the viewer panel", async ({ page }) => {
  // The module moved; bookmarks to it must land on what replaced it.
  await page.goto("/ids/validate");
  await expect(page).toHaveURL(/\/viewer\?panel=ids/);
  await expect(page.getByRole("button", { name: /Load \.ids/ })).toBeVisible();
});

test("says what is missing before it can run", async ({ page }) => {
  await page.goto("/viewer?panel=ids");

  await expect(page.getByText("No specification loaded")).toBeVisible();
  await expect(page.getByText(/Load a model to validate against/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Validate/ })).toBeDisabled();
});

test("validates a model and reports the failing wall", async ({ page }) => {
  await openWithModel(page);
  await runValidation(page);

  // The fixture has two walls; only Wall B lacks Pset_WallCommon.FireRating.
  await expect(page.getByText(/1 of 1 not satisfied/)).toBeVisible();
  await expect(page.getByText("Wall B")).toBeVisible();
  await expect(page.getByText(/1 failing element/)).toBeVisible();
});

test("shows a clean run as passing", async ({ page }) => {
  await openWithModel(page);
  await runValidation(page, IDS_PASS);

  await expect(page.getByText("All specifications satisfied")).toBeVisible();
  await expect(page.getByText("Nothing failed.")).toBeVisible();
});

test("filters the failure list to one specification", async ({ page }) => {
  await openWithModel(page);
  await runValidation(page);

  await page.getByRole("button", { name: /Walls carry a fire rating/ }).click();
  await expect(page.getByText(/failing elements? in this specification/)).toBeVisible();
});




test("jumps from a failure into the viewer", async ({ page }) => {
  // The payoff, and now without leaving the page: the reason is a sentence, and
  // the wall it names is somewhere in the model beside it.
  await openWithModel(page);
  await runValidation(page);

  await page.getByRole("button", { name: "Show", exact: true }).first().click();

  // Isolation is what "show me this one" means, and the viewer only enables
  // "Show all" when something is actually hidden or isolated.
  await expect(page.getByRole("button", { name: "Show all" })).toBeEnabled();

  // Opening the Classes tab must not undo it. `isolated` is a single shared
  // slot, and the class filter used to clear it on mount whether or not the
  // isolation was its own — so simply looking at the class list silently
  // un-isolated the element the validator had just framed. Radix only mounts
  // the tab's content when it is opened, which is why this needs saying out
  // loud rather than being covered by the assertion above.
  await page.getByRole("tab", { name: "Classes" }).click();
  await expect(page.getByRole("button", { name: "Show all" })).toBeEnabled();
});


test("downloads a self-contained HTML report", async ({ page }) => {
  await openWithModel(page);
  await runValidation(page);

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "HTML report" }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.html$/);
});

test("the HTML report matches the page's language, not always English", async ({ page }) => {
  // Regression test: the report used to be hard-coded English regardless of
  // the app's own locale, which read as broken to a Portuguese-speaking user
  // downloading a report from a Portuguese page.
  await openWithModel(page);
  await runValidation(page);

  await page.getByRole("banner").getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: "Português" }).click();

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Relatório HTML" }).click();
  const file = await download;

  const reportPath = await file.path();
  const html = reportPath
    ? await import("node:fs").then((fs) => fs.promises.readFile(reportPath, "utf-8"))
    : "";

  expect(html).toContain('<html lang="pt">');
  expect(html).toMatch(/Relatório IDS/);
  expect(html).toMatch(/Modelos/);
  expect(html).toMatch(/Especificações/);
  // This fixture has a failing wall, so the verdict and tile read in
  // Portuguese rather than the old hard-coded English.
  expect(html).toMatch(/não satisfeita/);
  expect(html).toMatch(/Elementos em falha/);
  expect(html).not.toContain("not satisfied");
  expect(html).not.toContain("Failing elements");
});

test("exports BCF and opens it in the BCF manager", async ({ page }) => {
  await openWithModel(page);
  await runValidation(page);

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: "Export BCF" }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.bcf$/);

  // Handed straight to Phase 7 so it can be triaged without a round trip
  // through the filesystem.
  // The BCF manager is a tab in the viewer now, not a page.
  await page.getByRole("tab", { name: "BCF" }).click();
  await expect(page.getByLabel("Topic title")).toHaveValue(/Wall B/);
});

/**
 * Decode the topic's stored snapshot and report how much of it is
 * foreground — different enough from its own background to be the framed
 * element, not the empty space around it. Background is sampled from the
 * image's own corners rather than a hard-coded theme colour, since a
 * correctly-framed element leaves them clear.
 */
async function foregroundFraction(page: Page): Promise<number> {
  const source = await page.getByRole("img", { name: /^Snapshot for/ }).getAttribute("src");
  expect(source).toBeTruthy();

  return page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const size = 64;
        const scratch = document.createElement("canvas");
        scratch.width = size;
        scratch.height = size;
        const context = scratch.getContext("2d")!;
        const image = new Image();
        image.onload = () => {
          context.drawImage(image, 0, 0, size, size);
          const { data } = context.getImageData(0, 0, size, size);
          const at = (x: number, y: number) => {
            const i = (y * size + x) * 4;
            return [data[i], data[i + 1], data[i + 2]];
          };
          const corners = [
            at(0, 0),
            at(size - 1, 0),
            at(0, size - 1),
            at(size - 1, size - 1),
          ];
          const bg = [0, 1, 2].map(
            (c) => corners.reduce((sum, p) => sum + p[c], 0) / corners.length,
          );

          let foreground = 0;
          for (let i = 0; i < data.length; i += 4) {
            const diff =
              Math.abs(data[i] - bg[0]) +
              Math.abs(data[i + 1] - bg[1]) +
              Math.abs(data[i + 2] - bg[2]);
            if (diff > 30) foreground += 1;
          }
          resolve(foreground / (size * size));
        };
        image.src = url;
      }),
    source!,
  );
}

test("frames the failing element large enough to see, not lost in the whole model", async ({
  page,
}) => {
  // A BCF viewpoint captured with nothing actually in frame — because the
  // camera stayed wherever it was, or the isolated element has no geometry
  // to bound — is the failure this guards against: a topic whose snapshot
  // is technically present and practically blank. This fixture's "whole
  // model" (one other wall plus a slab) is too close in scale to Wall A
  // alone to also prove the *specific* historical bug (fitting the camera
  // to every visible model instead of the isolated element) on its own; a
  // building large enough to make that difference dramatic would need its
  // own fixture. The renderer-level fix is `boundsOfRefs` in
  // `lib/viewer/renderer.ts`, reusing the same per-entity `ranges` lookup
  // `setSelection` already relies on.
  //
  // Deliberately not `wall-fire-rating.ids`/Wall B: Wall B's `Representation`
  // is `$` in this fixture — no geometry at all — so it can never prove a
  // framing fix either way. `wall-is-internal.ids` fails Wall A instead,
  // which has real geometry.
  await openWithModel(page);
  await runValidation(page, path.resolve(__dirname, "../fixtures/ids/wall-is-internal.ids"));

  await page.getByRole("button", { name: "Export BCF" }).click();
  await page.getByLabel("Capture a snapshot per topic").click();

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await download;

  await page.getByRole("tab", { name: "BCF" }).click();
  await expect(page.getByLabel("Topic title")).toHaveValue(/Wall A/);

  const fraction = await foregroundFraction(page);
  expect(fraction).toBeGreaterThan(0.05);
});

test("runs the validation off the main thread", async ({ page }) => {
  // If validation ran on the UI thread the page would be frozen for its whole
  // duration and this click would time out.
  await openWithModel(page);
  await page.locator('input[accept*=".ids"]').setInputFiles(IDS);
  await page.getByRole("button", { name: /^Validate/ }).click();

  // The viewport keeps rendering while validation runs in the worker.
  await expect(page.locator("[data-model-canvas]")).toBeVisible();
  await expect(page.getByRole("status").first()).toBeVisible({ timeout: 60_000 });
});

test("sends nothing over the network while validating", async ({ page, baseURL }) => {
  const ownOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) foreign.push(request.url());
  });

  await openWithModel(page);
  await runValidation(page);

  expect(foreign).toEqual([]);
});

test("renders with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await openWithModel(page);
  await runValidation(page);
  await page.waitForTimeout(1200);

  expect(errors).toEqual([]);
});
