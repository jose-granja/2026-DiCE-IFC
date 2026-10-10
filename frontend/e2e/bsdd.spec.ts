import { expect, test } from "@playwright/test";

/**
 * bSDD suggestions in the IDS editor.
 *
 * Reaches the real dictionary through `/api/bsdd`, so this is the one IDS test
 * that needs a network — bSDD sends no CORS headers, which is why the proxy
 * exists at all.
 */

test("the proxy forwards a dictionary lookup", async ({ request }) => {
  const response = await request.get(
    "/api/bsdd?path=%2Fapi%2FDictionary%2Fv1&limit=5",
  );
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(Array.isArray(body.dictionaries)).toBe(true);
});

test("the proxy refuses an endpoint that is not allow-listed", async ({ request }) => {
  // Without the list this forwards anything under the bSDD host.
  const response = await request.get("/api/bsdd?path=%2Fapi%2FAnything");
  expect(response.status()).toBe(400);
});

test("IFC 4.3 is selected by default without an eager request", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/bsdd")) calls.push(r.url());
  });

  await page.goto("/ids/create");
  await expect(page.getByText(/^IFC 4\.3$/)).toBeVisible();
  await page.waitForTimeout(1500);

  expect(calls).toEqual([]);
});

test("debounces IFC class typing and suggests its predefined types", async ({
  page,
}) => {
  const calls: Array<{ path: string | null; search: string | null }> = [];
  await page.route("**/api/bsdd?*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path");
    calls.push({ path, search: url.searchParams.get("SearchText") });

    if (path === "/api/Class/Search/v1") {
      await route.fulfill({
        json: {
          classes: [
            {
              uri: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall",
              name: "IfcWall",
              referenceCode: "IfcWall",
              dictionaryName: "IFC",
            },
          ],
        },
      });
      return;
    }

    if (path === "/api/Class/v1") {
      await route.fulfill({
        json: {
          referenceCode: "IfcWall",
          childClassReferences: [
            {
              uri: "https://example.test/IfcWallSHEAR",
              name: "Shear",
              code: "IfcWallSHEAR",
            },
            {
              uri: "https://example.test/IfcWallSOLIDWALL",
              name: "Solid Wall",
              code: "IfcWallSOLIDWALL",
            },
          ],
        },
      });
      return;
    }

    await route.abort();
  });

  await page.goto("/ids/create");
  await page.getByRole("button", { name: "Add specification" }).click();
  await page.getByRole("button", { name: "Add facet" }).first().click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  const ifcClass = page.getByLabel("IFC class");
  for (const partial of ["I", "IF", "IFC", "IFCW", "IFCWA", "IFCWAL", "IFCWALL"]) {
    await ifcClass.fill(partial);
    await page.waitForTimeout(50);
  }

  await expect
    .poll(() => calls.length)
    .toBe(1);
  await page.waitForTimeout(500);

  expect(calls).toEqual([{ path: "/api/Class/Search/v1", search: "IFCWALL" }]);
  await expect(page.locator("datalist option[value='IFCWALL']")).toHaveCount(1);

  await page.getByRole("button", { name: /Predefined type/ }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({ path: "/api/Class/v1", search: null });
  await expect(page.locator("datalist option[value='SHEAR']")).toHaveCount(1);
  await expect(page.locator("datalist option[value='SOLIDWALL']")).toHaveCount(1);
});

test("the default IFC dictionary suggests classes, property sets and values", async ({
  page,
}) => {
  await page.goto("/ids/create");
  await expect(page.getByText(/^IFC 4\.3/)).toBeVisible();

  // Name a class, which is what keys every suggestion below.
  await page.getByRole("button", { name: "Add specification" }).click();
  const appliesTo = page.locator("section").filter({ hasText: "Filters" }).first();
  await appliesTo.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  await page.getByLabel("IFC class").fill("IFCWALL");

  // Now bSDD knows the class, so a property facet can propose its property
  // sets — Pset_WallCommon among them.
  const mustSatisfy = page.locator("section").filter({ hasText: "Must satisfy" }).first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Property" }).click();

  const options = page.locator("datalist option");
  await expect
    .poll(
      async () =>
        (await options.evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLOptionElement).value),
        )).includes("Pset_WallCommon"),
      { timeout: 45_000 },
    )
    .toBe(true);

  // And an enumerated property proposes the values it accepts — the suggestion
  // a loaded model cannot give.
  await page.getByLabel("Property set").fill("Pset_WallCommon");
  await page.getByLabel("Property name").fill("Status");
  await expect(page.getByText(/values? from bSDD:/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/NEW|EXISTING|DEMOLISH/)).toBeVisible();
});

test("fills the data type and offers the URI when a bSDD property is named", async ({
  page,
}) => {
  await page.goto("/ids/create");

  await page.getByRole("button", { name: "Add specification" }).click();
  const appliesTo = page.locator("section").filter({ hasText: "Filters" }).first();
  await appliesTo.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  await page.getByLabel("IFC class").fill("IFCWALL");

  const mustSatisfy = page.locator("section").filter({ hasText: "Must satisfy" }).first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Property" }).click();
  await page.getByLabel("Property set").fill("Pset_WallCommon");

  // LoadBearing is Boolean in bSDD, which maps to exactly one IFC type.
  await page.getByLabel("Property name").fill("LoadBearing");

  const dataType = page.getByLabel("Data type");
  // The lookup may resolve after the name was typed, in which case the field
  // stays empty and the offer appears instead. Either is a pass; what must
  // not happen is the author being left to guess.
  const offer = page.getByRole("button", { name: /IFCBOOLEAN.*from bSDD/ });
  await expect
    .poll(
      async () =>
        (await dataType.inputValue()) === "IFCBOOLEAN" ||
        (await offer.count()) > 0,
      { timeout: 45_000 },
    )
    .toBe(true);

  if ((await dataType.inputValue()) !== "IFCBOOLEAN") {
    await offer.click();
  }
  await expect(dataType).toHaveValue("IFCBOOLEAN");

  // And the URI, which is the pointer that makes the facet resolvable.
  const useUri = page.getByRole("button", { name: /Use the URI from bSDD/ });
  if ((await useUri.count()) > 0) await useUri.click();
  await expect(page.getByLabel("URI")).toHaveValue(
    /identifier\.buildingsmart\.org.*Pset_WallCommon\/LoadBearing/,
  );
});

test("does not guess a measure for a property bSDD only calls Real", async ({
  page,
}) => {
  // ThermalTransmittance is IfcThermalTransmittanceMeasure, but bSDD says only
  // "Real". Filling IFCREAL would match no element and report a pass over an
  // empty set, so the editor explains instead of guessing.
  await page.goto("/ids/create");

  await page.getByRole("button", { name: "Add specification" }).click();
  const appliesTo = page.locator("section").filter({ hasText: "Filters" }).first();
  await appliesTo.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Entity" }).click();
  await page.getByLabel("IFC class").fill("IFCWALL");

  const mustSatisfy = page.locator("section").filter({ hasText: "Must satisfy" }).first();
  await mustSatisfy.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("menuitem", { name: "Property" }).click();
  await page.getByLabel("Property set").fill("Pset_WallCommon");
  await page.getByLabel("Property name").fill("ThermalTransmittance");

  await expect(page.getByText(/not which IFC measure/)).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByLabel("Data type")).toHaveValue("");
});
