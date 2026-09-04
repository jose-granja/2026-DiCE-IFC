import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The signing module, end to end.
 *
 * Vitest proves the cryptography: real WebCrypto keys, real certificates, real
 * signatures, verified for both RSA and ECDSA, with tamper detection. What only
 * a browser shows is that the pages wire it together — files in, container out,
 * and the verifier reading back what the signer produced.
 *
 * The build runs with the default (`webeid`) provider, which cannot sign
 * because the Portuguese Web eID fork does not exist yet (ADR 004). So the
 * signing-flow tests drive the crypto through the page's own code path only
 * where the provider allows; the rest assert the honest failure and the setup
 * guidance, which is what a user actually meets today.
 */

const IFC4 = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

async function openSign(page: Page) {
  await page.goto("/sign/ifc");
  await expect(page.getByRole("heading", { name: "Sign IFC", level: 1 })).toBeVisible();
}

test("carries the local-processing badge", async ({ page }) => {
  await openSign(page);
  await expect(page.getByRole("link", { name: /processed locally/i })).toBeVisible();
});

test("queues files and reports their size", async ({ page }) => {
  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);

  await expect(
    page.getByRole("cell", { name: "georeferenced-wall-ifc4.ifc", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign" })).toBeEnabled();
});

test("explains what each signature mode guarantees", async ({ page }) => {
  // The difference between the modes is a guarantee the user is entitled to
  // understand, not an implementation detail.
  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);

  await expect(page.getByText(/One PIN entry\./)).toBeVisible();
  await expect(page.getByText(/no longer independently verifiable/)).toBeVisible();

  await page.getByRole("combobox", { name: "Signature mode" }).click();
  await page.getByRole("option", { name: "One signature per file" }).click();

  await expect(page.getByText(/One PIN entry per file\./)).toBeVisible();
  await expect(page.getByText(/entirely on its own/)).toBeVisible();
});

test("removes a queued file", async ({ page }) => {
  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);

  await page.getByRole("button", { name: /Remove georeferenced-wall/ }).click();
  await expect(page.getByText("No files selected.")).toBeVisible();
});

test("fails honestly when there is no card companion", async ({ page }) => {
  // The truthful state on every machine today: the Portuguese Web eID build
  // does not exist. Claiming otherwise would send people to a PIN dialog that
  // never appears.
  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await page.getByRole("button", { name: "Sign" }).click();

  await expect(page.getByText(/card companion is not available/i).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Check your signing setup" }),
  ).toBeVisible();
});

test("never shows a PIN field", async ({ page }) => {
  // A hard rule from ADR 004: the middleware raises its own dialog, and this
  // application must never ask for a PIN.
  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);

  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel(/pin/i)).toHaveCount(0);
});

test("sends nothing over the network while preparing a signature", async ({
  page,
  baseURL,
}) => {
  // Loopback is excluded deliberately, not overlooked: since ADR 007 the
  // signing companion runs on 127.0.0.1 and is part of the trust boundary. The
  // claim under test is that nothing reaches *the network* — and that what does
  // reach the companion is a digest, which `lib/signing/providers/companion.ts`
  // is where to check.
  const ownOrigin = new URL(baseURL!).origin;
  const isLoopback = (url: string) => {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost";
  };

  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (new URL(url).origin !== ownOrigin && !isLoopback(url)) foreign.push(url);
  });

  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await page.getByRole("button", { name: "Sign" }).click();
  await expect(page.getByText(/card companion is not available/i).first()).toBeVisible();

  expect(foreign).toEqual([]);
});

test("the BCF module is the same flow", async ({ page }) => {
  await page.goto("/sign/bcf");
  await expect(page.getByRole("heading", { name: "Sign BCF", level: 1 })).toBeVisible();
  await expect(page.getByText(/valid BCF zip/)).toBeVisible();
});

test("setup lists what has to be installed, and what is missing", async ({ page }) => {
  await page.goto("/sign/setup");

  await expect(
    page.getByRole("heading", { name: "Signing setup", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("DiCE-IFC signing companion")).toBeVisible();
  await expect(
    page.getByRole("term").filter({ hasText: "Autenticação.gov middleware" }),
  ).toBeVisible();
});

test("setup pairs with a running companion with nothing typed", async ({
  page,
}) => {
  // Against the companion actually running on this machine: it reads the
  // Autenticação.gov middleware and enumerates the reader over PKCS#11.
  const status = await page.request
    .get("http://127.0.0.1:8765/status")
    .then((r) => (r.ok() ? r.json() : null))
    .catch(() => null);
  test.skip(!status, "companion not running");

  // The companion only pairs with origins it was started for — loopback on the
  // app's usual port. Running the suite on another port (PLAYWRIGHT_PORT, to
  // keep off a busy :3000) is therefore a missing precondition, not a failure:
  // the refusal being tested for elsewhere is working exactly as intended.
  await page.goto("/sign/setup");
  const pairable = await page.request
    .get("http://127.0.0.1:8765/pair", {
      headers: { Origin: new URL(page.url()).origin },
    })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!pairable, "this origin is not on the companion's allow-list");
  // The reader row asserts hardware presence, so an unplugged reader is an
  // absent precondition rather than a failure of the app.
  test.skip(!status?.reader, "no card reader connected");

  await page.goto("/sign/setup");

  // No URL box, no token box, no Pair button — the page fetches the token from
  // the companion's /pair endpoint, which only answers an allow-listed origin.
  await expect(page.getByLabel("Token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pair", exact: true })).toHaveCount(0);

  await expect(page.getByText("DiCE-IFC signing companion")).toBeVisible();
  // The middleware and reader are detected; the card is reported separately so
  // a failure says which piece is missing.
  await expect(page.getByText(/Reader — /)).toBeVisible({ timeout: 15_000 });

  // The *state* of the row, not its label: the label renders either way, so
  // asserting on it proves only that the page loaded.
  await expect(page.locator('[data-check="extension"]')).toHaveAttribute(
    "data-status",
    "ok",
    { timeout: 15_000 },
  );
});

test("setup pairs again by itself after the companion restarts", async ({ page }) => {
  const status = await page.request
    .get("http://127.0.0.1:8765/status")
    .then((r) => (r.ok() ? r.json() : null))
    .catch(() => null);
  test.skip(!status, "companion not running");

  // The companion only pairs with origins it was started for — loopback on the
  // app's usual port. Running the suite on another port (PLAYWRIGHT_PORT, to
  // keep off a busy :3000) is therefore a missing precondition, not a failure:
  // the refusal being tested for elsewhere is working exactly as intended.
  await page.goto("/sign/setup");
  const pairable = await page.request
    .get("http://127.0.0.1:8765/pair", {
      headers: { Origin: new URL(page.url()).origin },
    })
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!pairable, "this origin is not on the companion's allow-list");

  // A token left over from a previous run of the companion is stale, not wrong.
  // Surfacing that to the citizen would be asking them to understand a detail
  // that exists for our convenience.
  await page.goto("/sign/setup");
  await page.evaluate(() =>
    window.localStorage.setItem("dice-ifc.companion.token", "stale-from-last-run"),
  );
  await page.reload();

  await expect(page.locator('[data-check="extension"]')).toHaveAttribute(
    "data-status",
    "ok",
    { timeout: 15_000 },
  );
  const token = await page.evaluate(() =>
    window.localStorage.getItem("dice-ifc.companion.token"),
  );
  expect(token).not.toBe("stale-from-last-run");
});

test("setup offers an installer, or says how to build one", async ({ page }) => {
  await page.goto("/sign/setup");

  // Which of the two depends on NEXT_PUBLIC_COMPANION_DOWNLOAD_BASE. What must
  // never happen is a download button pointing at a URL that 404s.
  const button = page.getByRole("link", { name: /Download for / });
  if ((await button.count()) > 0) {
    await expect(button.first()).toHaveAttribute("href", /\.(pkg|exe)$/);
    // Unsigned installers warn on both platforms; saying so beforehand is the
    // difference between an expected warning and an abandoned install.
    await expect(page.getByText(/unidentified developer|SmartScreen/)).toBeVisible();
  } else {
    await expect(page.getByText(/No installer is published/)).toBeVisible();
  }
});

test("setup says CMD is out of scope and points elsewhere", async ({ page }) => {
  await page.goto("/sign/setup");

  await expect(
    page.getByRole("heading", { name: /Chave Móvel Digital is not supported/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Autenticação.gov desktop application/ }),
  ).toHaveAttribute("href", /autenticacao\.gov\.pt/);
});

test("verify reports a container that carries no signature", async ({ page }) => {
  await page.goto("/sign/verify");
  await expect(
    page.getByRole("heading", { name: "Verify a signature", level: 1 }),
  ).toBeVisible();

  // An unsigned IFC is not a container; the page must say so rather than throw.
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await expect(page.getByText(/not a readable ZIP|carries no signature/)).toBeVisible({
    timeout: 30_000,
  });
});

test("renders with no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await openSign(page);
  await page.setInputFiles('input[type="file"]', [IFC4]);
  await page.goto("/sign/setup");
  await page.goto("/sign/verify");
  await page.waitForTimeout(1200);

  expect(errors).toEqual([]);
});
