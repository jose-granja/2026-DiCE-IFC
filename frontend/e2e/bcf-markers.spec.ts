import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createTopic, emptyBcfFile, type BcfViewpoint } from "../lib/bcf/types";
import { serializeBcf } from "../lib/bcf/serialize";

const IFC = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

/** Two issues on the same wall exercise pin overlap as well as GUID resolution. */
async function importTopics(page: Page) {
  const viewpoint: BcfViewpoint = {
    guid: "aab00000-0000-4000-8000-000000000001", fileName: "view.bcfv",
    camera: { kind: "perspective", viewPoint: [10, -15, 10], direction: [-0.4, 1, -0.4], upVector: [0, 0, 1], fieldOfView: 60, aspectRatio: 1.5 },
    components: { selection: [{ ifcGuid: "7YvctVUKr0kugbFTf53O9L" }], defaultVisibility: true, exceptions: [], coloring: [] },
    clippingPlanes: [], lines: [], bitmaps: [],
  };
  const topics = ["Check wall finish", "Check wall height", "No location"].map((title, index) => ({
    ...createTopic({ title, author: "test@example.com", topicStatus: index === 1 ? "Closed" : "Open" }),
    viewpoints: index < 2 ? [viewpoint] : [],
  }));
  const { bytes } = serializeBcf({ ...emptyBcfFile(), topics });
  await page.locator('input[accept*=".bcf"]').setInputFiles({ name: "markers.bcf", mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  await expect(page.getByRole("button", { name: "Show 3D markers" })).toBeEnabled();
}

async function load(page: Page) {
  await page.goto("/viewer?panel=bcf");
  await page.locator('input[accept*=".ifc"]').setInputFiles(IFC);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
  await importTopics(page);
}

test("toggles all topic pins, keeps overlaps clickable, and follows the BCF filters", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await load(page);
  await expect(page.locator("[data-bcf-marker]")).toHaveCount(0);
  await page.getByRole("button", { name: "Show 3D markers" }).click();
  const markers = page.locator("[data-bcf-marker]");
  await expect(markers).toHaveCount(2);
  await expect(page.getByText("1 topic has no location to display.")).toBeVisible();
  await expect(markers.first()).toHaveAttribute("data-marker-source", "component");
  const first = await markers.nth(0).boundingBox();
  const second = await markers.nth(1).boundingBox();
  expect(Math.abs(first!.y - second!.y)).toBeGreaterThanOrEqual(36);

  await page.getByLabel("Search topics").fill("finish");
  await expect(markers).toHaveCount(1);
  await page.getByLabel("Search topics").fill("");
  await expect(markers).toHaveCount(2);
  await page.getByRole("button", { name: "Hide 3D markers" }).click();
  await expect(markers).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("pins track camera movement and open their topic from another panel", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByRole("button", { name: "Show 3D markers" }).click();
  const pin = page.getByRole("button", { name: "Open BCF topic: Check wall finish", exact: true });
  await expect(pin).toBeVisible();
  const before = await pin.getAttribute("style");
  const canvas = page.locator("[data-model-canvas]");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height * 0.7 + 30, { steps: 8 });
  await page.mouse.up();
  await expect(pin).not.toHaveAttribute("style", before!);
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await pin.click();
  await expect(page.getByLabel("Topic title")).toHaveValue("Check wall finish");
  await expect(page.getByText("Viewpoint restored.", { exact: true })).toBeVisible();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  // Returning through a marker must not reload the older draft over an edit.
  await page.getByLabel("Topic title").fill("Updated wall finish");
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page.getByRole("button", { name: "Open BCF topic: Updated wall finish", exact: true }).click();
  await expect(page.getByLabel("Topic title")).toHaveValue("Updated wall finish");
});

test("waits for a model and removes the pins when it is unloaded", async ({ page }) => {
  await page.goto("/viewer?panel=bcf");
  await importTopics(page);
  await page.getByRole("button", { name: "Show 3D markers" }).click();
  await expect(page.getByText("Load an IFC model to locate the topics.")).toBeVisible();
  await page.locator('input[accept*=".ifc"]').setInputFiles(IFC);
  await expect(page.locator("[data-bcf-marker]")).toHaveCount(2, { timeout: 60_000 });
  await page.getByRole("tab", { name: /^Models/ }).click();
  await page.getByRole("button", { name: "Close georeferenced-wall-ifc4.ifc" }).click();
  await expect(page.locator("[data-bcf-marker]")).toHaveCount(0);
});
