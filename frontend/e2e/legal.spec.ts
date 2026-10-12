import { expect, test } from "@playwright/test";

/**
 * What a public deployment has to say, and say in both languages: the licence
 * and credits page, the notices file it links, the credits' links, and the
 * verify page's warning that a valid signature is not a trust decision.
 */

test("the About page credits what the app is built on and whose data it shows", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "About, credits and licences", level: 1 })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Licence", level: 2 })).toBeVisible();
  await expect(page.getByText(/released under the MIT licence/)).toBeVisible();

  // The credits the providers' terms ask for, each with a link to its own terms.
  const osm = page.locator('[data-data-credit="osm"]');
  await expect(osm).toContainText("© OpenStreetMap contributors");
  await expect(osm.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  for (const key of ["openfreemap", "maptiler", "cesium", "google", "egm96", "epsg", "buildingsmart"]) {
    await expect(page.locator(`[data-data-credit="${key}"]`)).toBeVisible();
  }

  // The MPL-licensed packages are named, and the full notices are one click away.
  await expect(page.getByText(/Mozilla Public License 2\.0/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Disclaimers" })).toBeVisible();
  await expect(page.getByText("No warranty", { exact: true })).toBeVisible();
  await expect(page.getByText("Digital signatures", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Accessibility" })).toBeVisible();
});

test("the notices file is served and carries the licence texts", async ({ request }) => {
  const response = await request.get("/third-party-licenses.txt");
  expect(response.ok()).toBe(true);
  const text = await response.text();
  expect(text).toContain("DiCE-IFC — third-party notices");
  expect(text).toContain("@ifc-lite/parser");
  expect(text).toContain("Mozilla Public License");
  expect(text).toContain("Permission is hereby granted, free of charge");
  // The ones that need more than a name: Apache-2.0 for Cesium, the font and the data.
  expect(text).toContain("@cesium/engine");
  expect(text).toContain("Geist");
  expect(text).toContain("EGM96");
});

test("the About page is reachable from the navigation and reads in Portuguese", async ({ page, context }) => {
  await context.addCookies([{ name: "dice-locale", value: "pt", url: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_PORT ?? "3000") }]);
  await page.goto("/privacy");
  await page.getByRole("link", { name: "Sobre", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: "Sobre, créditos e licenças", level: 1 })).toBeVisible();
  await expect(page.getByText("Sem garantia", { exact: true })).toBeVisible();
});

test("the privacy page now covers server logs, cookies and storage", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "On the server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cookies and local storage" })).toBeVisible();
  await expect(page.getByText(/dice-locale/)).toBeVisible();
  await expect(page.getByText(/no analytics, advertising or tracking cookies/i)).toBeVisible();
});

for (const route of ["/sign/ifc", "/sign/bcf", "/sign/verify"]) {
  test(`the trust notice on ${route} is folded away, and opens on request`, async ({ page }) => {
    await page.goto(route);
    const notice = page.locator("details[data-trust-notice], details[data-embedded-trust]");
    await expect(notice).toHaveCount(1);

    // Closed to begin with — its text is not on screen…
    await expect(notice).not.toHaveAttribute("open", "");
    await expect(notice.locator("p")).toBeHidden();
    await expect(notice.locator("summary")).toContainText("What this check does and does not establish");

    // …and is there when asked for.
    await notice.locator("summary").click();
    await expect(notice).toHaveAttribute("open", "");
    await expect(notice.locator("p")).toContainText(/not checked/i);
  });
}

test("the trust notice's summary reads in Portuguese", async ({ page, context }) => {
  await context.addCookies([
    { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
  ]);
  await page.goto("/sign/verify");
  await expect(page.locator("details[data-trust-notice] summary")).toContainText(
    "O que esta verificação estabelece e o que não estabelece",
  );
});
