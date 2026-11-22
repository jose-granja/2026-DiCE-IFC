import http from "node:http";
import { expect, test, type Page } from "@playwright/test";

import { checkTimestampToken } from "../lib/signing/timestamp";
import { fakeTimestampResponse } from "../lib/signing/__tests__/fake-tsa";

/**
 * Time-stamping, through the real route handler in the production build.
 *
 * `playwright.config.ts` points the app at a fake authority on a fixed port; this
 * file is that authority. The signing itself needs a card, so the signature side
 * is covered by Vitest against real keys; what only a running server shows is the
 * route, its limits, and what the signing page offers because of it.
 */

// One worker runs all of these, or each would try to be the authority.
test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.TSA_TEST_PORT ?? 3199);
const received: Array<{ length: number; type: string | undefined }> = [];
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ length: body.length, type: request.headers["content-type"] });
      response.writeHead(200, { "Content-Type": "application/timestamp-reply" });
      response.end(Buffer.from(fakeTimestampResponse(new Uint8Array(body))));
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});
test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const DIGEST = "cd".repeat(32);

// A companion running on the machine that runs the tests would add its own
// time-stamp source; these are about the deployment's authority alone.
test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:8765/**", (route) => route.abort());
});

test("the route stamps a hash through the configured authority", async ({ request }) => {
  const service = await (await request.get("/api/tsa")).json();
  expect(service).toEqual({ configured: true, name: "Test time-stamp authority" });

  const before = received.length;
  const response = await request.post("/api/tsa", { data: { digest: DIGEST } });
  expect(response.status()).toBe(200);
  const body = await response.json();

  expect(body.tsa).toBe("Test time-stamp authority");
  const digest = Uint8Array.from(DIGEST.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const checked = checkTimestampToken(Uint8Array.from(Buffer.from(body.token, "base64")), { digest });
  expect(checked.valid).toBe(true);

  // What the authority received: one small request, of the right type.
  expect(received.length).toBe(before + 1);
  expect(received.at(-1)?.type).toBe("application/timestamp-query");
  expect(received.at(-1)!.length).toBeLessThan(80);
});

test("the route will not take anything but a hash", async ({ request }) => {
  const before = received.length;
  expect((await request.post("/api/tsa", { data: { digest: "not-a-hash" } })).status()).toBe(400);
  expect((await request.post("/api/tsa", { data: { digest: DIGEST, file: "x".repeat(4000) } })).status()).toBe(413);
  expect((await request.post("/api/tsa", { data: "plain text", headers: { "content-type": "text/plain" } })).status()).toBe(400);
  expect(received.length).toBe(before);
});

/** The time-stamp is offered for the IFCZIP container; "Inside IFC file", the default, only notes why not. */
async function openIfczip(page: Page, format = "IFCZIP container") {
  await page.goto("/sign/ifc");
  await page.getByRole("combobox", { name: /output format|formato de saída/i }).click();
  await page.getByRole("option", { name: format, exact: true }).click();
}

test("the signing page offers a time-stamp when the deployment has an authority", async ({ page }) => {
  await openIfczip(page);
  const option = page.locator("[data-timestamp-option]");
  await expect(option).toHaveAttribute("data-configured", "true");
  // Offered, and off until the user ticks it.
  await expect(option.getByLabel("Add a time-stamp from Test time-stamp authority")).not.toBeChecked();
  await expect(option).toContainText("Only a hash of the signature is sent");
});

test("the BCF signing page offers it too", async ({ page }) => {
  await page.goto("/sign/bcf");
  await expect(page.locator("[data-timestamp-option]")).toHaveAttribute("data-configured", "true");
  await expect(page.getByLabel("Add a time-stamp from Test time-stamp authority")).not.toBeChecked();
});

test("the signing page says so when the deployment has none", async ({ page }) => {
  await page.route("**/api/tsa", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { configured: false } })
      : route.continue(),
  );
  await openIfczip(page);
  // Nothing to offer, and no note saying so either.
  await expect(page.locator("[data-signature-details]")).toBeVisible();
  await expect(page.locator("[data-timestamp-option]")).toHaveCount(0);
  await expect(page.locator("#ifc-sign-timestamp")).toHaveCount(0);
});

test("the signing page reads in Portuguese", async ({ page, context }) => {
  await context.addCookies([
    { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
  ]);
  await openIfczip(page, "Contentor IFCZIP");
  await expect(page.locator("[data-timestamp-option]")).toContainText("Acrescentar um selo temporal de Test time-stamp authority");
});

test("the privacy page lists the time-stamp request", async ({ page }) => {
  await page.goto("/privacy");
  // Two ways out: this app's server for its own authority, and the companion
  // for the Cartão de Cidadão service.
  await expect(page.getByText(/SHA-256 hash of a signature's own value/)).toHaveCount(2);
  await expect(page.getByText(/ts\.cartaodecidadao\.pt/).first()).toBeVisible();
});
