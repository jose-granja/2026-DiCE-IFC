import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { issuePass, PASS_COOKIE } from "../lib/human-check/pass";

/**
 * The human check (ADR 013), on the production build.
 *
 * The main test server runs without it — it is off unless a deployment sets
 * the keys — so this file starts a second `next start` on the same build with
 * Cloudflare's published **test keys**: a site key whose widget always passes
 * on its own, and a secret Cloudflare always accepts. The gate itself needs no
 * network; the last test walks through the real widget and is skipped when
 * challenges.cloudflare.com cannot be reached.
 */

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.HUMAN_CHECK_TEST_PORT ?? 3198);
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_KEY = "1x00000000000000000000AA";
const SECRET = "1x0000000000000000000000000000000AA";
let server: ChildProcess;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  server = spawn(path.resolve(__dirname, "../node_modules/.bin/next"), ["start", "--port", String(PORT)], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_PASS_HOURS: "1" },
    stdio: "ignore",
  });
  for (let tries = 0; ; tries += 1) {
    try {
      if ((await fetch(`${BASE}/privacy`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (tries > 120) throw new Error("the second server did not start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
test.afterAll(() => {
  server?.kill();
});

test("without a pass, pages go to the check and API calls are refused", async ({ request }) => {
  const page = await request.get(`${BASE}/viewer?panel=bcf`, { maxRedirects: 0 });
  expect(page.status()).toBe(307);
  // Next writes a same-origin redirect as a relative Location.
  expect(page.headers().location).toBe("/human-check?next=%2Fviewer%3Fpanel%3Dbcf");

  expect((await request.get(`${BASE}/api/tsa`, { maxRedirects: 0 })).status()).toBe(403);
  // A prefetch header used to skip the proxy altogether; it does not skip the check.
  expect((await request.get(`${BASE}/api/tsa`, { headers: { Purpose: "prefetch" } })).status()).toBe(403);
  expect((await request.get(`${BASE}/viewer`, { headers: { "Next-Router-Prefetch": "1" }, maxRedirects: 0 })).status()).toBe(307);

  // Open to everyone: the check, what it sends (privacy), and static files.
  expect((await request.get(`${BASE}/privacy`)).status()).toBe(200);
  expect((await request.get(`${BASE}/third-party-licenses.txt`)).status()).toBe(200);
  const check = await request.get(`${BASE}/human-check?next=/viewer`);
  expect(check.status()).toBe(200);
  // Cloudflare is let in on the check page only.
  expect(check.headers()["content-security-policy"]).toContain("https://challenges.cloudflare.com");

  // Only a token Cloudflare accepts makes a pass.
  const bad = await request.post(`${BASE}/api/human-check`, { data: { token: "" } });
  expect(bad.status()).toBe(403);
  const crossSite = await request.post(`${BASE}/api/human-check`, {
    data: { token: "x" },
    headers: { Origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
});

test("a valid pass opens the site, and nothing from Cloudflare loads there", async ({ request }) => {
  const pass = await issuePass(SECRET, 600);
  const headers = { Cookie: `${PASS_COOKIE}=${pass}` };
  const viewer = await request.get(`${BASE}/viewer`, { headers, maxRedirects: 0 });
  expect(viewer.status()).toBe(200);
  expect(viewer.headers()["content-security-policy"]).not.toContain("challenges.cloudflare.com");
  expect((await request.get(`${BASE}/api/tsa`, { headers })).status()).toBe(200);
  // Already passed: the check sends you on.
  const check = await request.get(`${BASE}/human-check?next=%2Fabout`, { headers, maxRedirects: 0 });
  expect(check.status()).toBe(307);
  expect(check.headers().location).toBe("/about");

  // A pass from another secret, or an expired one, is no pass.
  const forged = await issuePass("not-the-secret", 600);
  expect((await request.get(`${BASE}/viewer`, { headers: { Cookie: `${PASS_COOKIE}=${forged}` }, maxRedirects: 0 })).status()).toBe(307);
  const expired = await issuePass(SECRET, 600, Date.now() - 3_600_000);
  expect((await request.get(`${BASE}/viewer`, { headers: { Cookie: `${PASS_COOKIE}=${expired}` }, maxRedirects: 0 })).status()).toBe(307);
});

test("a visitor passes the real widget and lands on the page they asked for", async ({ page }) => {
  test.setTimeout(60_000);
  const reachable = await fetch("https://challenges.cloudflare.com/turnstile/v0/api.js", {
    signal: AbortSignal.timeout(5_000),
  }).then(
    (response) => response.ok,
    () => false,
  );
  test.skip(!reachable, "challenges.cloudflare.com is not reachable from here");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) {
      errors.push(message.text());
    }
  });

  await page.goto(`${BASE}/viewer?panel=bcf`);
  await expect(page).toHaveURL(/\/human-check\?next=/);
  await expect(page.getByRole("heading", { name: /human|pessoa/ })).toBeVisible();
  // The test site key's widget solves itself; the page then goes on.
  await page.waitForURL(`${BASE}/viewer?panel=bcf`, { timeout: 30_000 });
  const cookie = (await page.context().cookies()).find((entry) => entry.name === PASS_COOKIE);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(errors).toEqual([]);
});
