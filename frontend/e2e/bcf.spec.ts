import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

import { readAnnotatedSnapshot } from "../lib/bcf/annotations";

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

/** Pixels of the viewpoint card's snapshot close to `rgb`, read from the image itself. */
async function snapshotPixels(page: Page, rgb: [number, number, number]) {
  return page.locator("[data-viewpoint] img").first().evaluate(async (element, [r, g, b]) => {
    const img = element as HTMLImageElement;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - r) < 24 && Math.abs(data[i + 1] - g) < 24 && Math.abs(data[i + 2] - b) < 24) count += 1;
    }
    return count;
  }, rgb);
}

test("annotates a viewpoint's snapshot, keeps the drawing editable, and updates the view under it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });

  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Marked up");
  await page.getByRole("button", { name: "Capture current view" }).click();
  const red: [number, number, number] = [0xe5, 0x48, 0x4d];
  await expect(page.locator("[data-viewpoint] img")).toBeVisible();
  const redBefore = await snapshotPixels(page, red);

  // Straight from the capture's own toast.
  await page.getByRole("button", { name: "Annotate", exact: true }).click();
  const editor = page.locator("[data-annotation-editor]");
  const canvas = editor.locator("[data-annotation-canvas]");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
  const dragOn = async (from: readonly [number, number], to: readonly [number, number]) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 6 });
    await page.mouse.up();
  };

  // An arrow (the default tool), a revision cloud and a text.
  await dragOn(at(0.15, 0.2), at(0.55, 0.6));
  await editor.getByRole("button", { name: "Revision cloud" }).click();
  await dragOn(at(0.6, 0.55), at(0.85, 0.85));
  await editor.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(...at(0.1, 0.08));
  await editor.getByLabel("Annotation text").fill("Falta revestimento");
  await editor.getByLabel("Annotation text").press("Enter");
  await expect(canvas).toHaveAttribute("data-annotation-count", "3");

  // Undo and redo, by button and by keyboard.
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "2");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(canvas).toHaveAttribute("data-annotation-count", "3");

  // Moving a shape with the select tool is a step of its own.
  await editor.getByRole("button", { name: "Select and move" }).click();
  await dragOn(at(0.35, 0.4), at(0.4, 0.45));
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "3");

  await editor.screenshot({ path: testInfo.outputPath("annotation-editor.png") });
  await editor.getByRole("button", { name: "Save annotations" }).click();
  await expect(page.getByText("3 annotations saved in the snapshot.")).toBeVisible();
  await expect(editor).toHaveCount(0);

  // Drawn into the image itself, which is what any other BCF tool shows.
  await expect.poll(() => snapshotPixels(page, red)).toBeGreaterThan(redBefore + 200);

  // And still editable: the editor opens on the same three shapes.
  await page.getByRole("button", { name: "Annotate the snapshot" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "3");
  await editor.getByRole("button", { name: "Cancel" }).click();

  // Update puts the current view under the drawing, keeping it.
  await page.getByRole("button", { name: "Update with the current view" }).click();
  await expect(page.getByText(/Its 3 annotations were kept/)).toBeVisible();
  await expect(page.locator("[data-viewpoint]")).toHaveCount(1);
  await page.getByRole("button", { name: "Annotate the snapshot" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "3");
  await editor.getByRole("button", { name: "Remove all annotations" }).click();
  await editor.getByRole("button", { name: "Save annotations" }).click();
  await expect(page.getByText("Annotations removed from the snapshot.")).toBeVisible();
  await expect.poll(() => snapshotPixels(page, red)).toBeLessThan(redBefore + 50);
});

test("an exported topic carries its annotated snapshot, still editable when read back", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Exported markup");
  await page.getByRole("button", { name: "Capture current view" }).click();
  await page.getByRole("button", { name: "Annotate the snapshot" }).click();
  const canvas = page.locator("[data-annotation-canvas]");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save annotations" }).click();
  await expect(page.getByText("1 annotation saved in the snapshot.")).toBeVisible();

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Export \.bcf/ }).click();
  const exported = testInfo.outputPath("annotated.bcf");
  await (await download).saveAs(exported);

  // In the archive, the snapshot is a PNG with the drawing in its private chunk.
  const entries = unzipSync(new Uint8Array(await readFile(exported)));
  const snapshots = Object.entries(entries).filter(([name]) => name.endsWith(".png"));
  expect(snapshots).toHaveLength(1);
  expect(readAnnotatedSnapshot(snapshots[0][1])?.shapes).toEqual([expect.objectContaining({ kind: "arrow" })]);

  // Read back into a fresh session, the arrow is there to edit.
  await openBcf(page);
  await importFiles(page, [exported]);
  await openFirstTopic(page);
  await page.getByRole("button", { name: "Annotate the snapshot" }).click();
  await expect(canvas).toHaveAttribute("data-annotation-count", "1");
});

/** A picture as a file from the computer, drawn in the page: `width`×`height`, one colour. */
async function pictureFile(page: Page, name: string, width: number, height: number, colour: string, type: string) {
  const base64 = await page.evaluate(
    ([w, h, fill, mime]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d")!;
      context.fillStyle = fill;
      context.fillRect(0, 0, w, h);
      return canvas.toDataURL(mime).split(",")[1];
    },
    [width, height, colour, type] as const,
  );
  return { name, mimeType: type, buffer: Buffer.from(base64, "base64") };
}

test("a picture from the computer becomes a viewpoint with the current view, replaces a snapshot, and opens large", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  await page.getByRole("button", { name: "New topic" }).click();
  await page.getByLabel("Topic title").fill("Site photo");

  // A large photo comes in scaled to 1500 px on its longest side, as a PNG —
  // saved with the viewer's camera and elements, as a capture would be.
  const photo = await pictureFile(page, "site.jpg", 3000, 2000, "#2060c0", "image/jpeg");
  await page.locator("[data-picture-input]").first().setInputFiles(photo);
  await expect(page.getByText("“site.jpg” added as a viewpoint, with the current view's camera and elements.")).toBeVisible();
  const card = page.locator("[data-viewpoint]").first();
  await expect(card).toContainText("perspective camera");
  await card.getByRole("button", { name: "Open viewpoint", exact: true }).click();
  await expect(page.getByText("Viewpoint restored.")).toBeVisible({ timeout: 30_000 });
  const size = (image: import("@playwright/test").Locator) =>
    image.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      return [element.naturalWidth, element.naturalHeight];
    });
  await expect.poll(() => size(card.locator("img"))).toEqual([1500, 1000]);

  // Opened large, in a dialog.
  await card.getByRole("button", { name: "View picture" }).click();
  const dialog = page.locator("[data-picture-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Snapshot — Site photo");
  await expect(dialog).toContainText("1500 × 1000 px");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A captured view's snapshot replaced by a picture keeps its camera.
  await page.getByRole("button", { name: "Capture current view" }).click();
  const captured = page.locator("[data-viewpoint]").nth(1);
  await expect(captured.locator("img")).toBeVisible();
  const sketch = await pictureFile(page, "sketch.png", 400, 300, "#30a46c", "image/png");
  await captured.locator("[data-picture-input]").setInputFiles(sketch);
  await expect(page.getByText("Snapshot replaced with “sketch.png”.")).toBeVisible();
  await expect.poll(() => size(captured.locator("img"))).toEqual([400, 300]);
  await expect(captured.getByRole("button", { name: "Open viewpoint", exact: true })).toBeEnabled();

  // Something that is not a picture is refused, and nothing changes.
  await captured.locator("[data-picture-input]").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a picture"),
  });
  await expect(page.getByText("“notes.txt” is not a picture.")).toBeVisible();
  await expect.poll(() => size(captured.locator("img"))).toEqual([400, 300]);

  // Exported: both viewpoints keep their view, the photo's with its camera and elements.
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Export \.bcf/ }).click();
  const exported = testInfo.outputPath("pictures.bcf");
  await (await download).saveAs(exported);
  const entries = unzipSync(new Uint8Array(await readFile(exported)));
  const names = Object.keys(entries);
  expect(names.filter((name) => name.endsWith(".png"))).toHaveLength(2);
  const views = names.filter((name) => name.endsWith(".bcfv")).map((name) => new TextDecoder().decode(entries[name]));
  expect(views).toHaveLength(2);
  for (const view of views) expect(view).toMatch(/<PerspectiveCamera>[\s\S]*<Components>|<Components>[\s\S]*<PerspectiveCamera>/);

  // With no model open there is no view to save: the picture is kept on its own.
  await openBcf(page);
  await importFiles(page, [exported]);
  await openFirstTopic(page);
  await expect(page.locator("[data-viewpoint]")).toHaveCount(2);
  await page.locator("[data-picture-input]").first().setInputFiles(photo);
  await expect(page.getByText("“site.jpg” added as a picture only", { exact: false })).toBeVisible();
  const alone = page.locator("[data-viewpoint]").nth(2);
  await expect(alone).toContainText("Picture only");
  await expect(alone.getByRole("button", { name: "Open viewpoint", exact: true })).toBeDisabled();
});

/** The pages of a PDF: page objects stay readable though their contents are compressed. */
function pdfPages(bytes: Buffer): number {
  return bytes.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;
}

test("downloads a PDF report of every topic, or of the checked ones", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await page.getByRole("tab", { name: "BCF", exact: true }).click();
  const report = page.locator("[data-bcf-report]");
  await expect(report).toBeDisabled();

  for (const title of ["Wall too thin", "Slab edge"]) {
    await page.getByRole("button", { name: "New topic" }).click();
    await page.getByLabel("Topic title").fill(title);
    await page.getByRole("button", { name: "Capture current view" }).click();
    await expect(page.locator("[data-viewpoint] img")).toBeVisible();
    await page.getByRole("button", { name: "All topics" }).click();
  }

  const download = async (name: string) => {
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await report.click();
    const file = await downloading;
    const saved = testInfo.outputPath(name);
    await file.saveAs(saved);
    return { suggested: file.suggestedFilename(), bytes: await readFile(saved) };
  };

  // Nothing checked: every topic — a cover, then a page each, with its snapshot.
  await expect(report).toHaveAttribute("data-report-scope", "all");
  const all = await download("all.pdf");
  expect(all.suggested).toMatch(/-report\.pdf$/);
  expect(all.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfPages(all.bytes)).toBe(3);
  expect(all.bytes.toString("latin1")).toContain("/Subtype /Image");
  await expect(page.getByText(/PDF report of 2 topics downloaded/)).toBeVisible();

  // One checked: only that one.
  await page.getByRole("checkbox", { name: "Select Slab edge for bulk editing" }).check();
  await expect(report).toHaveAttribute("data-report-scope", "selected");
  await report.hover();
  await expect(page.getByRole("tooltip")).toContainText("PDF report of the 1 selected topic");
  const one = await download("one.pdf");
  expect(pdfPages(one.bytes)).toBe(2);
  await expect(page.getByText(/PDF report of 1 topic downloaded/)).toBeVisible();
});
