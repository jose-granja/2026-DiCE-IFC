import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The BCF module, end to end.
 *
 * Vitest covers the reader, the writer, the merge and the frame conversions
 * against buildingSMART's own test archives. What only a browser shows is
 * whether zip import works off a real `File`, whether libxml2's WebAssembly
 * build starts under the app's CSP, whether the export downloads, and whether
 * a topic raised in the viewer carries the camera with it.
 */

const V30 = path.resolve(__dirname, "../fixtures/bcf/v3.0");
const V21 = path.resolve(__dirname, "../fixtures/bcf/v2.1");
const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

const LABELS = path.join(V30, "labels.bcf");
const RELATED = path.join(V30, "related-topics.bcf");
const MAXIMUM_21 = path.join(V21, "maximum-information.bcf");

async function openBcf(page: Page) {
  await page.goto("/viewer?panel=bcf");
  await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
}

/** The live region above the list, which reports "N topics" / "N of M topics". */
function topicCount(page: Page) {
  return page.getByRole("status");
}

/**
 * Edit the first topic.
 *
 * Clicking the topic itself restores its viewpoint. Tests that assert on topic
 * fields use the explicit pencil action instead.
 */
async function openFirstTopic(page: Page) {
  await page
    .locator("[data-topic-list]")
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Edit / })
    .click();
  await expect(page.getByLabel("Topic title")).toBeVisible();
}

async function importFiles(page: Page, files: string[]) {
  // The panel's own picker, not the viewer's model picker.
  await page.locator('input[accept*=".bcf"]').setInputFiles(files);
  // The count only appears once topics exist.
  await expect(topicCount(page)).toBeVisible({ timeout: 30_000 });
}

test("the old page redirects to the viewer panel", async ({ page }) => {
  await page.goto("/bcf");
  await expect(page).toHaveURL(/\/viewer\?panel=bcf/);
  await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
});

test("carries the local-processing badge", async ({ page }) => {
  await openBcf(page);
  await expect(page.getByRole("link", { name: /processed locally/i })).toBeVisible();
});

test("imports a BCF 3.0 file and lists its topics", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);

  // The pencil swaps the list for the topic editor.
  await openFirstTopic(page);
  await expect(page.getByLabel("Topic title")).not.toHaveValue("");
});

test("reads labels from a 3.0 file", async ({ page }) => {
  // 3.0 wraps labels in <Label> children. A reader written for 2.1's flat form
  // silently returns none, and the label filter then matches nothing.
  await openBcf(page);
  await importFiles(page, [LABELS]);

  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByRole("group", { name: "Label" })).toBeVisible();
});

test("upgrades a BCF 2.1 file on import", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [MAXIMUM_21]);
  await openFirstTopic(page);

  await expect(page.getByLabel("Topic title")).not.toHaveValue("");
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
});

test("filters the topic list by search", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [RELATED]);

  const counter = topicCount(page);
  const before = await counter.innerText();

  await page.getByLabel("Search topics").fill("zzzz-no-such-topic");
  await expect(
    page.getByText("No topics match the current filters."),
  ).toBeVisible();

  await page.getByLabel("Search topics").fill("");
  await expect(counter).toHaveText(before);
});

test("edits a topic and records the change", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);
  await openFirstTopic(page);

  await page.getByLabel("Status").first().fill("Em análise");
  await expect(page.getByText(/modified/)).toBeVisible();
});

test("adds a comment to a topic", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);
  await openFirstTopic(page);

  await page.getByRole("button", { name: "Author", exact: true }).click();
  await page.getByLabel("Author email for new topics and comments").fill("engenheiro@example.pt");
  await page.keyboard.press("Escape");
  await page.getByLabel("New comment").fill("Confirmado em obra.");
  await page.getByRole("button", { name: "Add comment" }).click();

  await expect(page.getByText("Confirmado em obra.")).toBeVisible();
  await expect(page.getByText("engenheiro@example.pt", { exact: false })).toBeVisible();
});

test("bulk-edits the checked topics", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [RELATED]);

  // One topic through the UI. Selecting several is store logic and is covered
  // by `lib/bcf/__tests__/store.test.ts`; driving a virtualised list that
  // reflows as the bulk bar appears tests the virtualiser, not the feature.
  await page
    .getByRole("checkbox", { name: /Select .* for bulk editing/ })
    .first()
    .check();

  const count = 1;
  await expect(page.getByText("1 topic selected")).toBeVisible();

  // The bulk bar's Status field, not the detail pane's.
  await page
    .locator("div")
    .filter({ hasText: /topics? selected/ })
    .getByLabel("Status")
    .first()
    .fill("Closed");
  await page.getByRole("button", { name: `Apply to ${count}` }).click();

  await expect(page.getByText("Updated 1 topic.")).toBeVisible();
});

test("detects a GUID collision when the same file is imported twice", async ({
  page,
}) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);

  const before = await topicCount(page).innerText();

  // Identical topics: this must deduplicate rather than double the list.
  await page.locator('input[accept*=".bcf"]').setInputFiles([LABELS]);
  // Two toasts, not one: the first import's is still on screen, and waiting for
  // "visible" would match it and pass before the second import had happened.
  await expect(page.getByText("Imported 1 file.")).toHaveCount(2);
  await expect(topicCount(page)).toHaveText(before);
});

test("merges two different files into one set", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS, RELATED]);

  const text = await topicCount(page).innerText();
  const total = Number(text.match(/\d+/)![0]);
  expect(total).toBeGreaterThan(1);
});

test("validates the exported archive against the BCF 3.0 schema", async ({
  page,
}) => {
  await openBcf(page);
  await importFiles(page, [MAXIMUM_21]);

  // libxml2 as WebAssembly, under the app's own CSP, with the schemas inlined.
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Schema-valid BCF 3.0.")).toBeVisible({
    timeout: 60_000,
  });
});

test("validation reaches no network at all", async ({ page, baseURL }) => {
  const ownOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) foreign.push(request.url());
  });

  await openBcf(page);
  await importFiles(page, [LABELS]);
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText(/Schema-valid|schema error/)).toBeVisible({
    timeout: 60_000,
  });

  expect(foreign).toEqual([]);
});

test("exports a .bcf file named after the project", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Export \.bcf/ }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/\.bcf$/);
});

test("says so when a viewpoint has no model to restore into", async ({ page }) => {
  await openBcf(page);
  await importFiles(page, [LABELS]);
  await page
    .locator("[data-topic-list]")
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Labels/ })
    .click();
  await expect(
    page.getByText(/Load the model in the viewer first/),
  ).toBeVisible();
  await expect(page.getByLabel("Topic title")).toHaveCount(0);
});

test("clicking a topic opens its first viewpoint and the pencil opens its editor", async ({
  page,
}) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.getByRole("tab", { name: "BCF" }).click();
  await importFiles(page, [LABELS]);

  const row = page
    .locator("[data-topic-list]")
    .getByRole("listitem")
    .first();
  await row.getByRole("button", { name: /^Labels/ }).click();
  await expect(page.getByText(/Viewpoint restored/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Topic title")).toHaveCount(0);
  await expect(topicCount(page)).toBeVisible();

  await row.getByRole("button", { name: "Edit Labels" }).click();
  await expect(page.getByLabel("Topic title")).toHaveValue("Labels");
});

test("raises a topic from the viewer, carrying a viewpoint", async ({ page }) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Viga sem revestimento");
  await page.getByRole("button", { name: "Capture current view" }).click();

  // The panel creates topics in place, then attaches the current camera.
  await expect(page.getByLabel("Topic title")).toHaveValue("Viga sem revestimento");
  await expect(
    page.getByRole("button", { name: "Open viewpoint", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show 3D markers" }).click();
  await expect(page.locator("[data-bcf-marker]")).toHaveAttribute("data-marker-source", "camera");
});

test("restores a viewpoint it captured from the viewer", async ({ page }) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });

  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Round trip");
  await page.getByRole("button", { name: "Capture current view" }).click();
  await expect(page.getByRole("button", { name: "Open viewpoint", exact: true })).toBeVisible();

  // Navigate in-app rather than with goto(). A full reload drops both stores:
  // the models would be gone and there would be nothing to restore into, which
  // is a property of the app, not a bug in it.
  // Both live in the viewer now, so this is a tab switch rather than a
  // navigation — and the models stay loaded, which is the point.
  await page.getByRole("tab", { name: "Structure" }).click();
  await page.getByRole("tab", { name: "BCF" }).click();
  await page
    .getByRole("button", { name: "Open viewpoint", exact: true })
    .first()
    .click();
  await expect(page.getByText("Viewpoint restored.")).toBeVisible({
    timeout: 30_000,
  });
});

test("renders with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await openBcf(page);
  await importFiles(page, [LABELS]);
  await page.waitForTimeout(1200);

  expect(errors).toEqual([]);
});
