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

async function selectWall(page: Page, locale: "en" | "pt" = "en") {
  await page.context().addCookies([{ name: "dice-locale", value: locale, url: "http://127.0.0.1" }]);
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
  await page.getByRole("tab", { name: /Structure|Estrutura/ }).click();
  const storey = page.getByRole("treeitem", { name: /Level 0/ }).first();
  await storey.getByRole("button", { name: /Expand|Expandir/ }).first().click();

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
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(page.getByText("REI 60")).toBeVisible();
  await expect(
    page.locator('[data-section="Properties"]').getByText("Pset_WallCommon"),
  ).toBeVisible();
});

test("separates what the type defines from what the occurrence does", async ({
  page,
}) => {
  // Worth its own tab: type properties are shared by every occurrence, so
  // changing one is not a local edit. Showing them mixed in with the
  // occurrence's own would misrepresent that.
  await selectWall(page);
  await page.getByRole("tab", { name: "Type", exact: true }).click();
  await expect(page.locator('[data-section="Type"]')).toBeVisible();
  await expect(page.getByText(/shared by every occurrence/i)).toBeVisible();

  // The occurrence's own property sets are a different tab, hidden while
  // this one is active — the two must never bleed into each other.
  await expect(page.getByText("REI 60")).toHaveCount(0);
});

test("renders booleans as words, not as 1 and 0", async ({ page }) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(page.getByText("LoadBearing")).toBeVisible();
  // `IFCBOOLEAN(.T.)` must read as Yes, not "true" or "1".
  await expect(
    page.locator('[data-section="Properties"]').getByText("Yes"),
  ).toBeVisible();
});

test("filters properties within the active tab", async ({ page }) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "Properties", exact: true }).click();

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

  await page.getByRole("tab", { name: "Properties", exact: true }).click();
  await expect(page.locator('[data-section="Properties"]')).toBeVisible();
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

test("lists required IDS fields without running validation, and refreshes on selection and IDS changes", async ({ page }, testInfo) => {
  await selectWall(page);
  await page.getByRole("tab", { name: "IDS requirements", exact: true }).click();
  await expect(page.getByText("Load an IDS file in the IDS panel", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "IDS", exact: true }).click();
  await page.locator('input[accept*=".ids"]').setInputFiles(path.resolve(__dirname, "../fixtures/ids/property-inspector.ids"));
  const list = page.locator("[data-ids-properties]");
  await expect(list.locator("[data-ids-property]")).toHaveCount(6);
  await expect(list.locator('[data-ids-property="FireRating"]')).toContainText("REI 60");
  await expect(list.locator('[data-ids-property="FireRating"]')).toContainText("Fire safety");
  await expect(list.locator('[data-ids-property="ThermalTransmittance"]')).toContainText("0.18");
  await expect(list.locator('[data-ids-property="IsExternal"]')).toContainText("Missing");
  await expect(list.locator('[data-ids-property="LoadBearing"]')).toContainText("Yes");
  await expect(list.locator('[data-ids-property="NetSideArea"]')).toContainText("12.5");
  await page.locator("[data-property-panel]").screenshot({ path: testInfo.outputPath("ids-properties.png") });

  await page.getByLabel("Filter properties").fill("missing");
  await expect(list.locator("[data-ids-property]")).toHaveCount(1);
  await page.getByLabel("Filter properties").fill("no such property");
  await expect(list.getByText("No properties match your search.")).toBeVisible();
  await page.getByLabel("Filter properties").fill("");

  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  const storey = page.getByRole("treeitem", { name: /Level 0/ }).first();
  // The tree is remounted when changing the left-hand tab.
  const expand = storey.getByRole("button", { name: "Expand", exact: true }).first();
  if (await expand.count()) await expand.click();
  await page.getByRole("treeitem", { name: "Wall B" }).first().click();
  await expect(list.locator('[data-ids-property="Name"]')).toContainText("Wall B");
  await storey.click();
  await expect(list.getByText("The loaded IDS has no required properties or attributes applicable to this element.")).toBeVisible();
  await page.getByRole("treeitem", { name: "Wall A" }).first().click();
  await expect(list.locator("[data-ids-property]")).toHaveCount(6);

  await page.getByRole("tab", { name: "IDS", exact: true }).click();
  await page.locator('input[accept*=".ids"]').setInputFiles(path.resolve(__dirname, "../fixtures/ids/wall-fire-rating.ids"));
  await expect(list.locator("[data-ids-property]")).toHaveCount(1);
  await expect(list.locator('[data-ids-property="FireRating"]')).toContainText("REI 60");
  await page.locator('input[accept*=".ids"]').setInputFiles({ name: "bad.ids", mimeType: "application/xml", buffer: Buffer.from("<ids>truncated") });
  await expect(page.locator("[data-property-panel]").getByRole("alert")).toContainText("could not be read");
  await expect(list).toHaveCount(0);
  await page.locator('input[accept*=".ids"]').setInputFiles(path.resolve(__dirname, "../fixtures/ids/property-inspector.ids"));
  await expect(list.locator("[data-ids-property]")).toHaveCount(6);
});

test("shows IDS requirements and missing values in Portuguese", async ({ page }) => {
  await selectWall(page, "pt");
  await page.getByRole("tab", { name: "Requisitos IDS", exact: true }).click();
  await expect(page.getByText("Carregue um ficheiro IDS", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "IDS", exact: true }).click();
  await page.locator('input[accept*=".ids"]').setInputFiles(path.resolve(__dirname, "../fixtures/ids/property-inspector.ids"));
  const list = page.locator("[data-ids-properties]");
  await expect(list.getByRole("columnheader", { name: "Valor atual" })).toBeVisible();
  await expect(list.locator('[data-ids-property="IsExternal"]')).toContainText("Em falta");
  await expect(list.locator('[data-ids-property="LoadBearing"]')).toContainText("Sim");
});
