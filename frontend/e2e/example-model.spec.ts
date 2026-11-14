import { expect, test } from "@playwright/test";

/**
 * The example model: one click on an empty viewer opens it, as if the visitor
 * had picked the file themselves. The only request is for the file itself,
 * from this origin.
 */

test("an empty viewer offers the example model, and opens it", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/examples/")) requests.push(`${request.method()} ${request.url()}`);
  });

  await page.goto("/viewer");
  const button = page.locator("[data-example-model]");
  await expect(button).toHaveText(/example model|modelo de exemplo/i);
  await button.click();

  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 150_000 });
  await expect(page.getByText("VNGaia_example.ifc").first()).toBeVisible();
  // The empty-viewer hint, and the button with it, are gone once a model is open.
  await expect(button).toHaveCount(0);
  expect(requests).toEqual([`GET ${new URL("/examples/VNGaia_example.ifc", baseURL).href}`]);
});
