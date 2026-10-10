import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Filtering by all five dimensions.
 *
 * The fixture is built for this: two walls and a slab, across two storeys, with
 * two materials, a wall type shared by both walls, and a group and a zone that
 * deliberately cut across class. Without data in every dimension the panel
 * renders empty sections and the tests prove nothing.
 */

const FIXTURE = path.resolve(__dirname, "../fixtures/ifc/facets-ifc4.ifc");

async function openFilters(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [FIXTURE]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });
  await page.getByRole("tab", { name: "Classes" }).click();
  await expect(page.locator("[data-filter-panel]")).toBeVisible();
}

/**
 * Expand a dimension if it is not already open.
 *
 * Not an unconditional click: `classes` starts expanded, so clicking its header
 * closes it — which is how the first version of this file "proved" the class
 * list contained no IfcWall.
 */
async function expand(page: Page, dimension: string) {
  const section = page.locator(`[data-facet="${dimension}"]`);
  const header = section.getByRole("button").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  return section;
}

/** Expand a dimension and tick one of its values. */
async function tick(page: Page, dimension: string, value: string) {
  const section = await expand(page, dimension);
  await section.getByLabel(value, { exact: true }).click();
}

test("offers every dimension the model records", async ({ page }) => {
  await openFilters(page);

  for (const dimension of ["hierarchy", "classes", "types", "materials", "groups"]) {
    await expect(page.locator(`[data-facet="${dimension}"]`)).toBeVisible();
  }

  // Populated, not merely present — an empty section proves nothing.
  await expect
    .poll(async () =>
      Number(
        (await page.locator('[data-facet="materials"]').innerText()).match(/\d+/)?.[0],
      ),
    )
    .toBeGreaterThan(0);
});

test("offers only things placed in the model, not its plumbing", async ({ page }) => {
  // The first attempt used a blocklist of entity prefixes and let
  // IfcLocalPlacement, IfcSIUnit and IfcDirection into the class list. The
  // definition is now "placed in the spatial hierarchy", which needs no
  // maintenance as the schema grows.
  await openFilters(page);
  const classes = await expand(page, "classes");
  const text = await classes.innerText();
  expect(text).toContain("IfcWall");
  for (const noise of ["IfcLocalPlacement", "IfcSIUnit", "IfcDirection", "IfcRelAggregates"]) {
    expect(text).not.toContain(noise);
  }
});

/**
 * How many entities the renderer is actually drawing, as `shown/total`.
 *
 * The first version of this test asserted that a "Clear" button appeared, which
 * is a statement about the panel and not about the model — and it passed while
 * the viewport was untouched, because `ViewerCanvas` had its own copy of the
 * visibility rule that never learned about the filter. This reads the renderer.
 */
function visibleEntities(page: Page) {
  return page.locator("[data-rendered-models]");
}

test("filtering hides elements in the viewport, and clearing brings them back", async ({
  page,
}) => {
  await openFilters(page);
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "3/3");

  // Only the slab is timber, so both walls go.
  await tick(page, "materials", "Timber CLT");
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "1/3");

  await page.getByRole("button", { name: /Clear 1/ }).click();
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "3/3");
  await expect(page.getByRole("button", { name: /Clear/ })).toHaveCount(0);
});

test("every filter value can be hidden and shown from its row", async ({ page }) => {
  await openFilters(page);
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "3/3");

  const values = [
    { dimension: "hierarchy", value: "Level 1", visible: "2/3" },
    { dimension: "classes", value: "IfcWall", visible: "1/3" },
    { dimension: "types", value: "Basic Wall 200", visible: "1/3" },
    { dimension: "materials", value: "Concrete C30/37", visible: "1/3" },
    { dimension: "groups", value: "Fire compartment 1", visible: "1/3" },
  ];

  // Check the renderer after every action, rather than only checking that an
  // eye icon changed. Showing the value again also prevents one row's hidden
  // members from affecting the next assertion.
  for (const { dimension, value, visible } of values) {
    await expand(page, dimension);
    await page.getByRole("button", { name: `Hide ${value}` }).click();
    await expect(visibleEntities(page)).toHaveAttribute(
      "data-visible-entities",
      visible,
    );

    await page.getByRole("button", { name: `Show ${value}` }).click();
    await expect(visibleEntities(page)).toHaveAttribute(
      "data-visible-entities",
      "3/3",
    );
  }
});

test("unions within a dimension and intersects across them", async ({ page }) => {
  // The rule that is easy to write backwards. Concrete is both walls; IfcSlab
  // is the slab; together they are nothing — and that must hide everything
  // rather than be mistaken for "no filter".
  await openFilters(page);
  await tick(page, "materials", "Concrete C30/37");
  await tick(page, "classes", "IfcSlab");

  await expect(page.getByRole("button", { name: /Clear 2/ })).toBeVisible();
  await expect(page.getByText(/every.*chosen category/i)).toBeVisible();
  // Concrete walls ∩ slabs is empty, and an empty filter must hide everything
  // rather than be mistaken for no filter at all.
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "0/3");
});

test("a group can cut across class", async ({ page }) => {
  // Fire compartment 1 holds one wall and the slab. A filter that could only
  // express "one class at a time" could not ask this question at all.
  await openFilters(page);
  await tick(page, "groups", "Fire compartment 1");
  // One wall and the slab — a question no class-only filter could ask.
  await expect(visibleEntities(page)).toHaveAttribute("data-visible-entities", "2/3");
});

test("the filter does not outlive the panel", async ({ page }) => {
  // Otherwise the viewer keeps hiding things with no visible control to
  // explain why, which reads as a rendering bug.
  await openFilters(page);
  await tick(page, "classes", "IfcSlab");
  await expect(page.getByRole("button", { name: /Clear 1/ })).toBeVisible();

  await page.getByRole("tab", { name: "Structure" }).click();
  await page.waitForTimeout(500);

  const hidden = await page.evaluate(() =>
    document.querySelectorAll("[data-filter-panel]").length,
  );
  expect(hidden).toBe(0);
});
