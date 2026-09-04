import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The information panel.
 *
 * It used to list property sets and nothing else, which left the reader unable
 * to tell whether an element's materials and classifications were missing from
 * the model or missing from the panel — the two look identical and mean
 * opposite things.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

async function selectWall(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });

  // Through the tree rather than the canvas: it is the accessible equivalent
  // and does not depend on where geometry lands on screen.
  //
  // The storey has to be expanded first — its elements are listed lazily, and
  // the disclosure is a separate control from the row itself, so clicking the
  // row selects the storey rather than opening it.
  await page.getByRole("tab", { name: "Structure" }).click();
  const storey = page.getByRole("treeitem", { name: /Level 0/ }).first();
  await storey.getByRole("button", { name: "Expand" }).first().click();

  // The element rows are labelled by express id, not name — the tree lists
  // them before their attributes have been read. `#100` is Wall A in this
  // fixture, which this repository authors, so it is stable.
  await page.getByRole("treeitem", { name: "#100", exact: true }).first().click();
  await expect(page.locator("[data-property-panel]")).toBeVisible();
}

test("shows attributes, materials and property sets", async ({ page }) => {
  await selectWall(page);

  await expect(page.locator('[data-section="Attributes"]')).toBeVisible();
  await expect(page.getByText("Concrete C30/37")).toBeVisible();
  await expect(page.getByText("REI 60")).toBeVisible();

  // Scoped: the occurrence and its type both carry a `Pset_WallCommon`, which
  // is exactly how real models are authored — and the reason the panel keeps
  // them in separate sections rather than merging them into one list.
  await expect(
    page.locator('[data-section="Property sets"]').getByText("Pset_WallCommon"),
  ).toBeVisible();
});

test("separates what the type defines from what the occurrence does", async ({
  page,
}) => {
  // Worth its own section: type properties are shared by every occurrence, so
  // changing one is not a local edit. Showing them mixed in with the
  // occurrence's own would misrepresent that.
  await selectWall(page);
  await expect(page.locator('[data-section="From its type"]')).toBeVisible();
  await expect(page.getByText(/shared by every occurrence/i)).toBeVisible();
});

test("renders booleans as words, not as 1 and 0", async ({ page }) => {
  await selectWall(page);
  await expect(page.getByText("LoadBearing")).toBeVisible();
  // `IFCBOOLEAN(.T.)` must read as Yes, not "true" or "1".
  await expect(
    page.locator('[data-section="Property sets"]').getByText("Yes"),
  ).toBeVisible();
});

test("filters properties across every section", async ({ page }) => {
  await selectWall(page);

  await page.getByLabel("Filter properties").fill("fire");
  await expect(page.getByText("REI 60")).toBeVisible();
  await expect(page.getByText("LoadBearing")).toHaveCount(0);

  await page.getByLabel("Filter properties").fill("");
  await expect(page.getByText("LoadBearing")).toBeVisible();
});

test("sections collapse, so a long list can be got past", async ({ page }) => {
  await selectWall(page);

  const header = page
    .locator('[data-section="Property sets"]')
    .getByRole("button")
    .first();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("REI 60")).toHaveCount(0);
});

test("says nothing is selected rather than showing an empty shell", async ({
  page,
}) => {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });
  await expect(page.getByText(/Select an element/)).toBeVisible();
});
