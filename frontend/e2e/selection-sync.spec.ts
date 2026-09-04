import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * A selection made in one place shows up in the others.
 *
 * Holding the model, its structure and its issues in one viewer is only worth
 * anything if a click connects them. Selecting in the viewport used to mark the
 * tree row `aria-selected` — invisibly, because storeys start collapsed — and
 * told the BCF panel nothing at all.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");
const LABELS = path.resolve(__dirname, "../fixtures/bcf/v3.0/labels.bcf");

async function load(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });
}

/** Select an element by clicking the middle of the viewport. */
async function clickModel(page: Page) {
  const box = (await page.locator("[data-model-canvas]").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("selecting in the viewport reveals the element in the tree", async ({ page }) => {
  await load(page);
  await page.getByRole("tab", { name: "Structure" }).click();

  // Storeys start collapsed — they can hold tens of thousands of elements — so
  // the row is not merely unhighlighted, it is not rendered at all.
  await expect(page.getByRole("treeitem", { name: /^#1/ })).toHaveCount(0);

  await clickModel(page);

  await expect
    .poll(async () => page.getByRole("treeitem", { selected: true }).count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
});

test("the tree selection survives switching panels and back", async ({ page }) => {
  await load(page);
  await clickModel(page);

  await page.getByRole("tab", { name: "Structure" }).click();
  await expect
    .poll(async () => page.getByRole("treeitem", { selected: true }).count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
});

test("the BCF panel says whether any topic refers to the selection", async ({
  page,
}) => {
  await load(page);
  await page.getByRole("tab", { name: "BCF" }).click();
  await page.locator('input[accept*=".bcf"]').setInputFiles([LABELS]);
  await expect(page.getByRole("status")).toBeVisible({ timeout: 30_000 });

  await clickModel(page);

  // Either a list of topics or an explicit "none" — never silence, which reads
  // as "there are no issues" when it means "nobody asked".
  await expect(
    page.locator("[data-related-topics]").or(
      page.getByText(/No topic refers to the selected element/),
    ),
  ).toBeVisible({ timeout: 20_000 });
});

test("nothing is claimed about issues when nothing is selected", async ({ page }) => {
  await load(page);
  await page.getByRole("tab", { name: "BCF" }).click();

  await expect(page.locator("[data-related-topics]")).toHaveCount(0);
  await expect(
    page.getByText(/No topic refers to the selected element/),
  ).toHaveCount(0);
});
