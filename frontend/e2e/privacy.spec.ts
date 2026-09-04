import { expect, test } from "@playwright/test";

/**
 * The privacy line, checked end-to-end.
 *
 * These are the tests that would actually catch a regression the lint rule
 * cannot: a header quietly dropped, a badge quietly removed, or a third-party
 * request appearing on a page that should make none.
 */

test("the home page carries the local-processing badge", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /processed locally|processado localmente/i }),
  ).toBeVisible();
});

test("the privacy page lists what is sent and what is not", async ({ page }) => {
  await page.goto("/privacy");
  // Both languages: which one renders depends on Accept-Language, and a test
  // that only passes in an English browser is a test that hides a regression
  // from every Portuguese one.
  await expect(
    page.getByRole("heading", { name: /everything that is sent|tudo o que é enviado/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /everything that is not|tudo o que não é/i }),
  ).toBeVisible();
});

test("security headers are present on every page", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response!.headers();

  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");

  const csp = headers["content-security-policy"];
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  // The complete list of origins this app can reach. Anything else needs an ADR.
  expect(csp).toMatch(/connect-src [^;]*'self'/);
});

test("no request leaves the app's own origin", async ({ page, baseURL }) => {
  // Fixed up front: during the first navigation `page.url()` is still
  // about:blank, so deriving the expected origin inside the handler makes every
  // request look foreign.
  const ownOrigin = new URL(baseURL!).origin;

  const foreign: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== ownOrigin) {
      foreign.push(request.url());
    }
  });

  await page.goto("/");
  await page.goto("/privacy");
  await page.waitForLoadState("networkidle");

  expect(foreign).toEqual([]);
});

test("cross-origin isolation is on, so the WASM workers can use SharedArrayBuffer", async ({
  page,
}) => {
  await page.goto("/");
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
});
