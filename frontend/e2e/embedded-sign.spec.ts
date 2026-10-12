import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { bitString, explicit, integer, name, nullValue, oid, sequence, utcTime } from "../lib/signing/der";

const IFC = resolve("fixtures/ifc/georeferenced-wall-ifc4.ifc");
const original = readFileSync(IFC);
const model = (fileName: string) => ({ name: fileName, mimeType: "application/octet-stream", buffer: original });

/**
 * Real RSA / EC signatures behind the companion protocol, without a card or
 * PIN. Node's keys support both the CMS SHA-256 profile and the SHA-512 XAdES
 * requests the companion's advertised algorithms negotiate.
 */
async function companion(page: Page, keyType: "RSA" | "EC", options: { badSignature?: boolean; cancelAt?: number } = {}) {
  const keys = keyType === "EC"
    ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = keyType === "EC"
    ? sequence(oid("1.2.840.10045.4.3.2"))
    : sequence(oid("1.2.840.113549.1.1.11"), nullValue());
  const subject = name([["CN", "BROWSER TEST KEY (NOT A CARD)"], ["C", "PT"]]);
  const tbs = sequence(explicit(0, integer(2)), integer(1), algorithm, subject,
    sequence(utcTime(new Date("2020-01-01T00:00:00Z")), utcTime(new Date("2040-01-01T00:00:00Z"))),
    subject, keys.publicKey.export({ type: "spki", format: "der" }));
  const certificate = Buffer.from(sequence(tbs, algorithm, bitString(sign("sha256", tbs, keys.privateKey)))).toString("base64");
  const requests: Buffer[] = [];
  await page.route("http://127.0.0.1:8765/**", async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "*",
      "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "content-type,x-dice-token",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    let body: unknown;
    if (path === "/pair") body = { token: "ephemeral-test-token" };
    else if (path === "/status") body = { middleware: "test", reader: "test", cardPresent: true, ready: true, paired: true };
    else if (path === "/certificate") body = { certificate, chain: [] };
    else if (path === "/sign") {
      const input = request.postDataJSON();
      const bytes = Buffer.from(input.data, "base64");
      requests.push(bytes);
      if (requests.length === options.cancelAt) {
        return route.fulfill({ status: 400, headers, json: { code: "cancelled", error: "Signing was cancelled." } });
      }
      expect(input.certificate).toBe(certificate);
      expect(input.hash).toMatch(/^SHA-(256|384|512)$/);
      const signature = sign(input.hash.toLowerCase().replace("-", ""), bytes,
        { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
      body = { signature: options.badSignature ? Buffer.alloc(64).toString("base64") : signature.toString("base64"),
        algorithm: `${keyType === "EC" ? "ES" : "RS"}${input.hash.slice(4)}`, certificate };
    } else throw new Error(`Unexpected companion endpoint: ${path}`);
    await route.fulfill({ headers, json: body });
  });
  return requests;
}

async function selectEmbedded(page: Page) {
  await page.getByRole("combobox", { name: "Output format" }).click();
  await page.getByRole("option", { name: "Inside IFC file", exact: true }).click();
}

async function openEmbedded(page: Page) {
  await page.goto("/sign/ifc");
  await expect(page.getByRole("heading", { name: "Sign IFC", exact: true })).toBeVisible();
  await selectEmbedded(page);
}

async function downloadOutput(page: Page, testInfo: TestInfo, index: number) {
  const event = page.waitForEvent("download");
  await page.locator("[data-sign-output]").nth(index).getByRole("button", { name: "Download", exact: true }).click();
  const download = await event;
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return { path, name: download.suggestedFilename(), bytes: readFileSync(path) };
}

test.beforeEach(async ({ context, baseURL, page }) => {
  await context.addCookies([{ name: "dice-locale", value: "en", url: baseURL! }]);
  await page.route("**/api/tsa", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { configured: false } });
  });
});

test("redirects the former embedded page to the unified signing page", async ({ page }) => {
  await page.goto("/sign/ifc-embedded");
  await expect(page).toHaveURL(/\/sign\/ifc$/);
  await expect(page.getByRole("heading", { name: "Sign IFC", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Output format" })).toContainText("IFCZIP container");
});

for (const keyType of ["RSA", "EC"] as const) {
  test(`signs through the companion, downloads and verifies ${keyType} IFC`, async ({ page, baseURL }, testInfo) => {
    const requests = await companion(page, keyType);
    const foreign: string[] = [], errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin && url.origin !== "http://127.0.0.1:8765") foreign.push(url.href);
      if (url.origin === new URL(baseURL!).origin) expect(request.postData()).toBeNull();
    });
    await openEmbedded(page);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.setInputFiles('input[type="file"]', IFC);
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
    expect(requests).toHaveLength(1);
    expect(requests[0].length).toBeLessThan(512);
    expect(requests[0].toString()).not.toMatch(/IFCWALL|ISO-10303|georeferenced-wall/);
    const signed = await downloadOutput(page, testInfo, 0);
    expect(signed.name).toBe("georeferenced-wall-ifc4-signed.ifc");
    expect(signed.bytes.subarray(0, original.length)).toEqual(original);
    expect(signed.bytes.toString()).toContain("/*\nSIGNATURE;");
    await page.getByRole("link", { name: "Verify signatures", exact: true }).click();
    await page.setInputFiles('input[type="file"]', signed.path);
    await expect(page.locator("[data-embedded-verification]")).toContainText("Signature integrity verified");
    await openEmbedded(page);
    await page.setInputFiles('input[type="file"]', signed.path);
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("already contains a signature");
    expect(requests).toHaveLength(1);
    await page.goto("/sign/verify");
    await page.setInputFiles('input[type="file"]', { name: "tampered.ifc", mimeType: "application/octet-stream",
      buffer: Buffer.from(signed.bytes.toString().replace("IFCWALL", "IFCSLAB")) });
    await expect(page.locator("[data-embedded-verification]")).toContainText("Signature could not be verified:");
    expect(requests).toHaveLength(1); // Verification is entirely offline.
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("signs multiple IFC files, downloads one archive and verifies each result", async ({ page }, testInfo) => {
  const requests = await companion(page, "EC");
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', [model("first.ifc"), model("second.ifc")]);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(2, { timeout: 30000 });
  expect(requests).toHaveLength(2);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (.zip)", exact: true }).click();
  const archive = await event;
  const path = testInfo.outputPath("signed-models.zip");
  await archive.saveAs(path);
  const files = unzipSync(readFileSync(path));
  expect(Object.keys(files).sort()).toEqual(["first-signed.ifc", "second-signed.ifc"]);
  for (const bytes of Object.values(files)) expect(Buffer.from(bytes).subarray(0, original.length)).toEqual(original);
  await page.getByRole("button", { name: "Clear files" }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(0);
  await page.getByRole("link", { name: "Verify signatures", exact: true }).click();
  await page.setInputFiles('input[type="file"]', Object.entries(files).map(([name, bytes]) => ({
    name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes),
  })));
  const verification = page.locator("[data-embedded-verification]");
  await expect(verification.getByText("Signature integrity verified", { exact: true })).toHaveCount(2);
  await expect(verification).toContainText("first-signed.ifc");
  await expect(verification).toContainText("second-signed.ifc");
  expect(requests).toHaveLength(2);
});

test("keeps completed files when a later PIN request is cancelled and stops the batch", async ({ page }) => {
  const requests = await companion(page, "RSA", { cancelAt: 2 });
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', [model("first.ifc"), model("second.ifc"), model("third.ifc")]);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("cancelled");
  await expect(page.locator("[data-sign-output]")).toHaveCount(1);
  await expect(page.locator("[data-sign-output]")).toContainText("first-signed.ifc");
  await expect(page.locator("[data-sign-output]").getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(2);
});

test("appends files, refuses duplicate names and retains the queue when switching formats", async ({ page }) => {
  await page.goto("/sign/ifc");
  await page.setInputFiles('input[type="file"]', model("first.ifc"));
  await page.setInputFiles('input[type="file"]', [model("first.ifc"), model("second.ifcxml")]);
  await expect(page.getByRole("cell", { name: "first.ifc", exact: true })).toHaveCount(1);
  await expect(page.getByRole("cell", { name: /^second\.ifcxml/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
  await selectEmbedded(page);
  await expect(page.getByRole("cell", { name: "first.ifc", exact: true })).toHaveCount(1);
  await expect(page.getByRole("cell", { name: /^second\.ifcxml/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove second.ifcxml", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
});

for (const mode of ["combined", "per-file"] as const) {
  test(`signs multiple files in IFCZIP ${mode} mode and verifies downloaded containers`, async ({ page }, testInfo) => {
    const requests = await companion(page, "RSA");
    await page.goto("/sign/ifc");
    if (mode === "per-file") {
      await page.getByRole("combobox", { name: "Signature mode" }).click();
      await page.getByRole("option", { name: "One signature per file", exact: true }).click();
    }
    await page.setInputFiles('input[type="file"]', [model("first.ifc"), model("second.ifc")]);
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    const count = mode === "combined" ? 1 : 2;
    await expect(page.locator("[data-sign-output]")).toHaveCount(count, { timeout: 30000 });
    expect(requests).toHaveLength(count);
    const outputs = [];
    for (let index = 0; index < count; index += 1) outputs.push(await downloadOutput(page, testInfo, index));
    for (const [index, output] of outputs.entries()) {
      expect(output.name).toMatch(/\.ifczip$/);
      const contents = unzipSync(output.bytes);
      const expected = mode === "combined" ? ["first.ifc", "second.ifc"] : [index === 0 ? "first.ifc" : "second.ifc"];
      expect(Object.keys(contents).filter((name) => name.endsWith(".ifc")).sort()).toEqual(expected);
      for (const name of expected) expect(Buffer.from(contents[name])).toEqual(original);
      expect(contents["META-INF/signatures001.xml"]).toBeDefined();
      await page.goto("/sign/verify");
      await page.setInputFiles('input[type="file"]', output.path);
      await expect(page.locator("[data-verify-file]").getByRole("status")).toContainText("Signature valid — the content is exactly what was signed");
    }
  });
}

test("does not offer a download for a bad card signature", async ({ page }) => {
  await companion(page, "EC", { badSignature: true });
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("No signed file was produced");
  await expect(page.locator("[data-sign-output]")).toHaveCount(0);
});

test("the viewer verifies embedded signatures and identifies altered models", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const requests = await companion(page, "RSA");
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signed = await downloadOutput(page, testInfo, 0);
  await page.goto("/viewer");
  await page.setInputFiles('input[type="file"]', signed.path);
  await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60000 });
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(page.getByText(/Signature valid — 1 signer/)).toBeVisible({ timeout: 30000 });
  // The status stands alone: what "valid" does and does not cover is on the About page.
  await expect(page.getByText(/qualified status are not checked/)).toHaveCount(0);
  await page.locator('input[accept*=".ifc"]').setInputFiles({ name: "tampered.ifc", mimeType: "application/octet-stream",
    buffer: Buffer.from(signed.bytes.toString().replace("IFCWALL", "IFCSLAB")) });
  await expect(page.getByText("Signature not valid", { exact: true })).toBeVisible({ timeout: 30000 });
  expect(requests).toHaveLength(1);
});

test("rejects invalid input before contacting the card, and is translated in Portuguese", async ({ page, context, baseURL }) => {
  const requests: string[] = [];
  await page.route("http://127.0.0.1:8765/**", (route) => { requests.push(route.request().url()); return route.abort(); });
  await context.addCookies([{ name: "dice-locale", value: "pt", url: baseURL! }]);
  await page.goto("/sign/ifc");
  await expect(page.getByRole("heading", { name: "Assinar IFC", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: /formato/i }).click();
  await page.getByRole("option").nth(1).click();
  await page.setInputFiles('input[type="file"]', { name: "bad.ifc", mimeType: "application/octet-stream", buffer: Buffer.from("not IFC") });
  await page.getByRole("button", { name: "Assinar", exact: true }).click();
  await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("não é um ficheiro IFC STEP suportado");
  expect(requests).toEqual([]);
});
