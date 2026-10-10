import { expect, test } from "@playwright/test";

/**
 * Server Actions survive the routes, including the ones that became redirects.
 *
 * A Server Action POSTs to the current URL and Next re-renders the route tree
 * the client sends with it. When a page becomes a `redirect()` — as `/georef`
 * and `/ids/validate` did — a client still holding the old tree can POST
 * against a segment the server no longer has, and the action runs and then the
 * response is a 404.
 *
 * `lib/actions/auth.ts` holds the only Server Actions in this app, and the
 * provider calls them on mount, so simply visiting a route exercises this.
 */

test("server actions succeed across the routes, including the redirected ones", async ({
  page,
}) => {
  const bad: string[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.status() >= 400) {
      bad.push(`${r.status()} ${r.url()}`);
    }
  });

  // Visit the redirected routes first: a client whose router tree still
  // references a page that has become a redirect is the shape most likely to
  // produce a 404 on a later action POST.
  for (const route of ["/georef", "/ids/validate", "/viewer", "/bcf", "/"]) {
    await page.goto(route);
    await page.waitForTimeout(2500);
  }

  // Then client-navigate, which is what a real session does.
  await page.getByRole("link", { name: "Viewer", exact: true }).first().click();
  await page.waitForTimeout(3000);

  console.log("FAILED POSTS:", bad.join(" | ") || "(none)");
  expect(bad).toEqual([]);
});
