import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * IDS authoring, end to end.
 *
 * Vitest covers the serialiser, the parser and the validators. What only a
 * browser shows is whether libxml2's WebAssembly build starts under the CSP,
 * whether the download works, and whether autocomplete reaches a real model.
 */

const IFC4 = path.resolve(
  __dirname,
  "../fixtures/ifc/georeferenced-wall-ifc4.ifc",
);

async function openAuthoring(page: Page) {
  await page.goto("/ids/create");
  await expect(
    page.getByRole("heading", { name: "IDS — Create", level: 1 }),
  ).toBeVisible();
}

/** Load a model first, so facet values can autocomplete from it. */
async function openWithModel(page: Page) {
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({
    timeout: 60_000,
  });
  await page.getByRole("link", { name: "IDS — Create" }).click();
  await expect(
    page.getByRole("heading", { name: "IDS — Create", level: 1 }),
  ).toBeVisible();
}

test("carries the local-processing badge", async ({ page }) => {
  await openAuthoring(page);
  await expect(
    page.getByRole("link", { name: /processed locally/i }),
  ).toBeVisible();
});

test("shows live XML that tracks what is authored", async ({ page }) => {
  await openAuthoring(page);

  await page.getByLabel("Document title *").fill("Structural handover");
  await page.getByRole("tab", { name: "XML" }).click();

  const preview = page.locator("pre");
  await expect(preview).toContainText("<title>Structural handover</title>");
  await expect(preview).toContainText(
    'xmlns="http://standards.buildingsmart.org/IDS"',
  );
});

test("emits well-formed XML from the production bundle", async ({ page }) => {
  // This is the assertion that caught the minifier folding the root element's
  // attribute concatenation and dropping both xmlns declarations. Vitest never
  // sees it: only the minified build is affected, so only a browser test can
  // find it.
  await openAuthoring(page);
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByRole("tab", { name: "XML" }).click();

  const xml = await page.locator("pre").innerText();

  expect(xml).toContain('xmlns="http://standards.buildingsmart.org/IDS"');
  expect(xml).toContain('xmlns:xs="http://www.w3.org/2001/XMLSchema"');
  expect(xml).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');

  const parseError = await page.evaluate((source) => {
    const dom = new DOMParser().parseFromString(source, "application/xml");
    return dom.querySelector("parsererror")?.textContent ?? null;
  }, xml);

  expect(parseError).toBeNull();
});

test("adds a specification with an entity applicability and a property requirement", async ({
  page,
}) => {
  await openAuthoring(page);

  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByLabel("Name *").fill("Walls carry a fire rating");

  // Applies to: IfcWall
  const appliesTo = page
    .locator("section")
    .filter({ hasText: "Applies to" })
    .first();
  await appliesTo.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  await page.getByLabel("IFC class").fill("IFCWALL");

  // Must satisfy: Pset_WallCommon.FireRating
  const mustSatisfy = page
    .locator("section")
    .filter({ hasText: "Must satisfy" })
    .first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Property" }).click();
  await page.getByLabel("Property set").fill("Pset_WallCommon");
  await page.getByLabel("Property name").fill("FireRating");

  await page.getByRole("tab", { name: "XML" }).click();
  await expect(page.getByText("<simpleValue>IFCWALL</simpleValue>")).toBeVisible();
  await expect(
    page.getByText("<simpleValue>Pset_WallCommon</simpleValue>"),
  ).toBeVisible();
});

test("offers only the cardinalities a facet's schema type allows", async ({
  page,
}) => {
  await openAuthoring(page);
  await page.getByRole("button", { name: "Add specification" }).click();

  const mustSatisfy = page
    .locator("section")
    .filter({ hasText: "Must satisfy" })
    .first();

  // Entity uses ids:simpleCardinality, which has no `optional`. Offering it
  // would let an author produce a file no validator accepts.
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  await page.getByRole("combobox", { name: "Cardinality" }).click();
  await expect(page.getByRole("option", { name: "required" })).toBeVisible();
  await expect(page.getByRole("option", { name: "prohibited" })).toBeVisible();
  await expect(page.getByRole("option", { name: "optional" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Attribute uses conditionalCardinality, which does.
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Attribute" }).click();
  await page.getByRole("combobox", { name: "Cardinality" }).last().click();
  await expect(page.getByRole("option", { name: "optional" })).toBeVisible();
});

test("edits an xs:restriction and writes it into the XML", async ({ page }) => {
  await openAuthoring(page);
  await page.getByRole("button", { name: "Add specification" }).click();

  const mustSatisfy = page
    .locator("section")
    .filter({ hasText: "Must satisfy" })
    .first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Attribute" }).click();

  await page.getByLabel("Attribute name").fill("Name");

  // Switch the name from a literal to a restriction, then add an enumeration.
  await page.getByRole("tab", { name: "Restriction" }).first().click();
  await page.getByLabel("Attribute name allowed value").fill("Wall-A");
  await page.keyboard.press("Enter");
  await page.getByLabel("Attribute name allowed value").fill("Wall-B");
  await page.keyboard.press("Enter");

  await page.getByRole("tab", { name: "XML" }).click();
  await expect(page.getByText('<xs:enumeration value="Wall-A"/>')).toBeVisible();
  await expect(page.getByText('<xs:enumeration value="Wall-B"/>')).toBeVisible();
});

test("reports authoring issues as the document is edited", async ({ page }) => {
  await openAuthoring(page);

  // An empty document tests nothing, and the issues panel says so. Scoped to
  // that panel: the empty specification list says something similar.
  const issues = page.getByRole("tabpanel", { name: /^Issues/ });
  await expect(
    issues.getByText("There are no specifications, so this file checks nothing."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add specification" }).click();
  await expect(issues.getByText(/no requirements/i)).toBeVisible();

  await page.getByLabel("Author").fill("not an email");
  await expect(page.getByText("The author must be an email address.")).toBeVisible();

  await page.getByLabel("Author").fill("engineer@example.com");
  await expect(
    page.getByText("The author must be an email address."),
  ).toHaveCount(0);
});

test("validates against the buildingSMART schema in the browser", async ({
  page,
}) => {
  await openAuthoring(page);
  await page.getByLabel("Document title *").fill("Schema check");
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByLabel("Name *").fill("Any entity");

  // libxml2 as WebAssembly, under the app's own CSP, with the schemas inlined.
  await page.getByRole("button", { name: /Validate against the IDS schema/i }).click();
  await expect(page.getByText("Schema-valid IDS 1.0")).toBeVisible({
    timeout: 60_000,
  });
});

test("validation reaches no network at all", async ({ page, baseURL }) => {
  const ownOrigin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) foreign.push(request.url());
  });

  await openAuthoring(page);
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByRole("button", { name: /Validate against the IDS schema/i }).click();
  await expect(page.getByText(/Schema-valid|schema error/)).toBeVisible({
    timeout: 60_000,
  });

  // The XSD imports xml.xsd and XMLSchema.xsd from w3.org; vendoring them is
  // what keeps this offline and inside the CSP.
  expect(foreign).toEqual([]);
});

test("downloads a .ids file named from the title", async ({ page }) => {
  await openAuthoring(page);
  await page.getByLabel("Document title *").fill("Structural Handover v2");

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Download \.ids/i }).click();
  const file = await download;

  expect(file.suggestedFilename()).toBe("structural-handover-v2.ids");
});

test("autocompletes facet values from a loaded model", async ({ page }) => {
  await openWithModel(page);

  await expect(
    page.getByRole("combobox", { name: "Model for autocomplete" }),
  ).toContainText("georeferenced-wall-ifc4.ifc");

  await page.getByRole("button", { name: "Add specification" }).click();
  const mustSatisfy = page
    .locator("section")
    .filter({ hasText: "Must satisfy" })
    .first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Property" }).click();

  // The datalist is populated from the model's real property sets — the whole
  // point of authoring next to a model rather than from memory.
  const options = page.locator("datalist option");
  await expect(options.filter({ has: page.locator("[value='Pset_WallCommon']") })).toHaveCount(
    0,
  );
  const values = await options.evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value),
  );
  expect(values).toContain("Pset_WallCommon");
});

test("renders with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await openAuthoring(page);
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.waitForTimeout(1200);

  expect(errors).toEqual([]);
});

test("the icon-only tabs of the preview panel are named and explain themselves", async ({ page }) => {
  await openAuthoring(page);

  const issues = page.getByRole("tab", { name: /^Issues/ });
  const xml = page.getByRole("tab", { name: "Live XML" });
  await expect(issues).toBeVisible();
  await expect(xml).toBeVisible();

  await xml.hover();
  await expect(page.getByRole("tooltip", { name: "Live XML" })).toBeVisible();

  // The reading tab needs a specification, and says so even while it is disabled.
  const natural = page.getByRole("tab", { name: /plain-language/i });
  await expect(natural).toBeDisabled();
  // Leave the first tooltip before reaching for the next: a pointer that jumps
  // straight from one trigger to another is read as heading for the open tooltip.
  await page.mouse.move(600, 600, { steps: 12 });
  await expect(page.getByRole("tooltip", { name: "Live XML" })).toHaveCount(0);
  await page.locator("[data-natural-tab-wrapper]").hover();
  await expect(page.getByRole("tooltip", { name: /Select a specification/ })).toBeVisible();

  await page.getByRole("button", { name: "Add specification" }).click();
  await expect(natural).toBeEnabled();
  await page.mouse.move(600, 600, { steps: 12 });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await natural.hover();
  await expect(page.getByRole("tooltip", { name: /Plain-language reading/ })).toBeVisible();
});
