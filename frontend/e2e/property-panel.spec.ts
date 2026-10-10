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

  // Grouped by class, then labelled by name once it has loaded (briefly
  // "#100" — its express id — before that resolves). "Wall A" is this
  // fixture's own IFC name for express id 100, which this repository
  // authors, so it is stable.
  await page.getByRole("treeitem", { name: "Wall A" }).first().click();
  await expect(page.locator("[data-property-panel]")).toBeVisible();
}

test("shows attributes, materials and property sets on their own tabs", async ({
  page,
}) => {
  await selectWall(page);

  // Attributes is the default tab. "Wall A" is this fixture's IFC `Name`,
  // now surfaced as its own attribute row rather than only the panel header.
  const attributes = page.locator('[data-section="Attributes"]');
  await expect(attributes).toBeVisible();
  await expect(attributes.getByText("Wall A", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Materials" }).click();
  await expect(page.getByText("Concrete C30/37")).toBeVisible();

  // Scoped: the occurrence and its type both carry a `Pset_WallCommon`, which
  // is exactly how real models are authored — and the reason the panel keeps
  // them in separate tabs rather than merging them into one list.
  await page.getByRole("tab", { name: "Property sets" }).click();
  await expect(page.getByText("REI 60")).toBeVisible();
  await expect(
    page.locator('[data-section="Property sets"]').getByText("Pset_WallCommon"),
  ).toBeVisible();
});

test("separates what the type defines from what the occurrence does", async ({
  page,
}) => {
  // Worth its own tab: type properties are shared by every occurrence, so
  // changing one is not a local edit. Showing them mixed in with the
  // occurrence's own would misrepresent that.
  await selectWall(page);
  await page.getByRole("tab", { name: "From its type" }).click();
  await expect(page.locator('[data-section="From its type"]')).toBeVisible();
  await expect(page.getByText(/shared by every occurrence/i)).toBeVisible();

  // The occurrence's own property sets are a different tab, hidden while
  // this one is active — the two must never bleed into each other.
  await expect(page.getByText("REI 60")).toHaveCount(0);
});

test("renders booleans as words, not as 1 and 0", async ({ page }) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "Property sets" }).click();
  await expect(page.getByText("LoadBearing")).toBeVisible();
  // `IFCBOOLEAN(.T.)` must read as Yes, not "true" or "1".
  await expect(
    page.locator('[data-section="Property sets"]').getByText("Yes"),
  ).toBeVisible();
});

test("filters properties within the active tab", async ({ page }) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "Property sets" }).click();

  await page.getByLabel("Filter properties").fill("fire");
  await expect(page.getByText("REI 60")).toBeVisible();
  await expect(page.getByText("LoadBearing")).toHaveCount(0);

  await page.getByLabel("Filter properties").fill("");
  await expect(page.getByText("LoadBearing")).toBeVisible();
});

test("expands a material's own properties as an accordion in the Materials tab", async ({
  page,
}) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "Materials" }).click();

  const trigger = page.getByRole("button", { name: "Concrete C30/37" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  // The material's own class, not the wall's — this fixture's material
  // carries no Pset, so this also proves the empty state, not just the open.
  await expect(page.getByText("IfcMaterial", { exact: true })).toBeVisible();
  await expect(page.getByText(/no property sets/i)).toBeVisible();

  // Collapsing hides its content again rather than leaving it stuck open.
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("IfcMaterial", { exact: true })).toHaveCount(0);
});

test("only one tab's content shows at a time", async ({ page }) => {
  await selectWall(page);

  await expect(page.locator('[data-section="Attributes"]')).toBeVisible();
  // Radix keeps the inactive tab panel's own element in the DOM (for
  // animation), but never renders its children — so its content is what must
  // be absent, not the panel itself.
  await expect(page.getByText("Pset_WallCommon")).toHaveCount(0);

  await page.getByRole("tab", { name: "Property sets" }).click();
  await expect(page.locator('[data-section="Property sets"]')).toBeVisible();
  await expect(page.getByText("Pset_WallCommon")).toBeVisible();
  await expect(page.locator('[data-section="Attributes"]')).not.toBeVisible();
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
