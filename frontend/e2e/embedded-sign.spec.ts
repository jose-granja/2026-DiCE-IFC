import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { bitString, explicit, integer, name, nullValue, oid, sequence, utcTime } from "../lib/signing/der";
import { fakeTimestampResponse } from "../lib/signing/__tests__/fake-tsa";

const IFC = resolve("fixtures/ifc/georeferenced-wall-ifc4.ifc");
const original = readFileSync(IFC);
const model = (fileName: string) => ({ name: fileName, mimeType: "application/octet-stream", buffer: original });

/**
 * Real RSA / EC signatures behind the companion protocol, without a card or
 * PIN. Node's keys support both the CMS SHA-256 profile and the SHA-512 XAdES
 * requests the companion's advertised algorithms negotiate.
 */
async function companion(page: Page, keyType: "RSA" | "EC", options: {
  badSignature?: boolean; cancelAt?: number; cn?: string;
  /** A 0.2 companion that relays the Cartão de Cidadão time-stamp; "limited" answers as its budget does when spent. */
  timestamp?: "ok" | "limited"; remaining?: number; stamps?: Buffer[];
} = {}) {
  const keys = keyType === "EC"
    ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = keyType === "EC"
    ? sequence(oid("1.2.840.10045.4.3.2"))
    : sequence(oid("1.2.840.113549.1.1.11"), nullValue());
  // A different CN is a different certificate (issuer and serial), as two citizens' cards are.
  const subject = name([["CN", options.cn ?? "BROWSER TEST KEY (NOT A CARD)"], ["C", "PT"]]);
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
    else if (path === "/status") body = {
      middleware: "test", reader: "test", cardPresent: true, ready: true, paired: true,
      ...(options.timestamp ? {
        features: ["sign", "timestamp"],
        timestamp: { name: "Cartão de Cidadão", remaining: options.remaining ?? 18 },
      } : {}),
    };
    else if (path === "/timestamp" && options.timestamp) {
      const query = Buffer.from(request.postDataJSON().request, "base64");
      options.stamps?.push(query);
      if (options.timestamp === "limited") {
        return route.fulfill({ status: 429, headers, json: {
          code: "rate-limited", retryAfter: 600,
          error: "The Cartão de Cidadão time-stamp service allows 20 requests in 20 minutes; try again in 10 min.",
        } });
      }
      body = { reply: Buffer.from(fakeTimestampResponse(new Uint8Array(query))).toString("base64"), name: "Cartão de Cidadão" };
    }
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

/** "Inside IFC file" is the default; the IFCZIP tests ask for the container. */
async function selectIfczip(page: Page) {
  await page.getByRole("combobox", { name: "Output format" }).click();
  await page.getByRole("option", { name: "IFCZIP container", exact: true }).click();
}

/**
 * Follow the link and wait for the verify page: the link navigates in the app,
 * and a file set before it lands would go to the signing page's input.
 */
async function openVerifyFromLink(page: Page) {
  await page.getByRole("link", { name: "Verify signatures", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify a signature", level: 1 })).toBeVisible();
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
  await expect(page.getByRole("combobox", { name: "Output format" })).toContainText("Inside IFC file");
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
    await openVerifyFromLink(page);
    await page.setInputFiles('input[type="file"]', signed.path);
    await expect(page.locator("[data-embedded-verification]")).toContainText("Signature integrity verified");
    // Signed already, so the page adds a signature rather than signing anew —
    // and this card already signed it, so it is refused before the PIN.
    await openEmbedded(page);
    await page.setInputFiles('input[type="file"]', signed.path);
    await expect(page.locator('[data-existing-signers="valid"]')).toHaveCount(1, { timeout: 30000 });
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("Your card has already signed this file.");
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
  await openVerifyFromLink(page);
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
  // IFCZIP takes any IFC file, so the .ifcxml is queued before switching to "Inside IFC file".
  await selectIfczip(page);
  await page.setInputFiles('input[type="file"]', model("first.ifc"));
  await page.setInputFiles('input[type="file"]', [model("first.ifc"), model("second.ifcxml")]);
  await expect(page.getByRole("cell", { name: /^first\.ifc/ })).toHaveCount(1);
  await expect(page.getByRole("cell", { name: /^second\.ifcxml/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
  await selectEmbedded(page);
  await expect(page.getByRole("cell", { name: /^first\.ifc/ })).toHaveCount(1);
  await expect(page.getByRole("cell", { name: /^second\.ifcxml/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove second.ifcxml", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
});

for (const mode of ["combined", "per-file"] as const) {
  test(`signs multiple files in IFCZIP ${mode} mode and verifies downloaded containers`, async ({ page }, testInfo) => {
    const requests = await companion(page, "RSA");
    await page.goto("/sign/ifc");
    await selectIfczip(page);
    await page.getByRole("combobox", { name: "Signature mode" }).click();
    await page.getByRole("option", {
      name: mode === "combined" ? "One signature over all files" : "One signature per file",
      exact: true,
    }).click();
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
  await page.getByRole("option", { name: "Dentro do ficheiro IFC", exact: true }).click();
  await page.setInputFiles('input[type="file"]', { name: "bad.ifc", mimeType: "application/octet-stream", buffer: Buffer.from("not IFC") });
  await page.getByRole("button", { name: "Assinar", exact: true }).click();
  await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("não é um ficheiro IFC STEP suportado");
  // The page asks `/status` whether the companion can time-stamp; that carries
  // nothing and uses no key. The card's own endpoints were never reached.
  expect(requests.filter((url) => !url.endsWith("/status"))).toEqual([]);
});

test("co-signs a signed IFC and a signed IFCZIP with a second card, and refuses the same card twice", async ({ page }, testInfo) => {
  // The author signs the model both ways.
  await companion(page, "RSA", { cn: "AUTHOR TEST KEY" });
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signedIfc = await downloadOutput(page, testInfo, 0);
  await page.goto("/sign/ifc");
  await selectIfczip(page);
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signedZip = await downloadOutput(page, testInfo, 0);

  // The reviewer's card adds a signature to both, each in its own format.
  await page.unroute("http://127.0.0.1:8765/**");
  const requests = await companion(page, "EC", { cn: "REVIEWER TEST KEY" });
  // Nobody says these are signed: the page reads them, and adds a signature.
  await page.goto("/sign/ifc");
  await expect(page.getByRole("combobox", { name: "What to do" })).toHaveCount(0);
  await page.setInputFiles('input[type="file"]', [
    { name: signedIfc.name, mimeType: "application/octet-stream", buffer: signedIfc.bytes },
    { name: signedZip.name, mimeType: "application/octet-stream", buffer: signedZip.bytes },
  ]);
  const existing = page.locator('[data-existing-signers="valid"]');
  await expect(existing).toHaveCount(2, { timeout: 30000 });
  await expect(existing.first()).toContainText("Signed by AUTHOR TEST KEY: your signature will be added.");
  // Every file is signed: the output format has nothing to apply to.
  await expect(page.getByRole("combobox", { name: "Output format" })).toHaveCount(0);
  await expect(page.locator("[data-cosign-hint]")).toBeVisible();
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator("[data-sign-outputs]")).toContainText("Every signature in each file, yours included, was verified");
  expect(requests).toHaveLength(2);

  const cosignedIfc = await downloadOutput(page, testInfo, 0);
  const cosignedZip = await downloadOutput(page, testInfo, 1);
  // Same files, same names, one more signature each; nothing before it moved.
  expect(cosignedIfc.name).toBe(signedIfc.name);
  expect(cosignedZip.name).toBe(signedZip.name);
  expect(cosignedIfc.bytes.subarray(0, signedIfc.bytes.length)).toEqual(signedIfc.bytes);
  expect(cosignedIfc.bytes.toString().match(/SIGNATURE;/g)).toHaveLength(2);
  const before = unzipSync(signedZip.bytes), after = unzipSync(cosignedZip.bytes);
  expect(Object.keys(after).filter((entry) => entry.startsWith("META-INF/signatures")).sort())
    .toEqual(["META-INF/signatures001.xml", "META-INF/signatures002.xml"]);
  expect(Buffer.from(after["META-INF/signatures001.xml"])).toEqual(Buffer.from(before["META-INF/signatures001.xml"]));

  await page.goto("/sign/verify");
  await page.setInputFiles('input[type="file"]', [cosignedIfc.path, cosignedZip.path]);
  await expect(page.locator('[data-verify-status="verified"]')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator("[data-verify-results]")).toContainText("REVIEWER TEST KEY");

  // The same card cannot sign the same file twice, and is not asked to.
  await page.goto("/sign/ifc");
  await page.setInputFiles('input[type="file"]', cosignedIfc.path);
  await expect(page.locator('[data-existing-signers="valid"]')).toHaveCount(1, { timeout: 30000 });
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator('[data-sign-errors] p[role="alert"]')).toContainText("Your card has already signed this file.");
  expect(requests).toHaveLength(2);
});

test("a mixed queue: the new file is signed, the signed one gets a signature, the altered one is refused", async ({ page }, testInfo) => {
  await companion(page, "RSA", { cn: "AUTHOR TEST KEY" });
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signed = await downloadOutput(page, testInfo, 0);

  await page.unroute("http://127.0.0.1:8765/**");
  const requests = await companion(page, "EC", { cn: "REVIEWER TEST KEY" });
  await openEmbedded(page);
  await page.setInputFiles('input[type="file"]', [
    model("new.ifc"),
    { name: "author-signed.ifc", mimeType: "application/octet-stream", buffer: signed.bytes },
    { name: "altered.ifc", mimeType: "application/octet-stream", buffer: Buffer.from(signed.bytes.toString().replace("IFCWALL", "IFCSLAB")) },
  ]);
  await expect(page.locator('[data-existing-signers="none"]')).toContainText("Not signed yet: it will be signed in the output format chosen above.", { timeout: 30000 });
  await expect(page.locator('[data-existing-signers="valid"]')).toContainText("Signed by AUTHOR TEST KEY");
  await expect(page.locator('[data-existing-signers="invalid"]')).toHaveCount(1);
  // One file still needs a format, so the choice stays on the page.
  await expect(page.getByRole("combobox", { name: "Output format" })).toBeVisible();

  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator("[data-sign-output]").nth(0)).toContainText("new-signed.ifc");
  await expect(page.locator("[data-sign-output]").nth(1)).toContainText("author-signed.ifc");
  const alerts = page.locator('[data-sign-errors] p[role="alert"]');
  await expect(alerts).toHaveCount(1);
  await expect(alerts.first()).toContainText("altered.ifc: A signature in this file does not verify");
  // Two PIN entries: the new file and the co-signature. The altered file cost none.
  expect(requests).toHaveLength(2);

  const cosigned = await downloadOutput(page, testInfo, 1);
  expect(cosigned.bytes.toString().match(/SIGNATURE;/g)).toHaveLength(2);
});

test("signs a reason and a place in both formats, and the verify page reads them back", async ({ page }, testInfo) => {
  const requests = await companion(page, "EC");
  await openEmbedded(page);
  const details = page.locator("[data-signature-details]");
  await expect(details).toBeVisible();
  // Professional attributes are shown, switched off, with the reason why (ADR 019).
  // A switch, off and disabled, and why behind its "i".
  await expect(page.getByRole("switch", { name: "Add professional attributes (SCAP)" })).toBeDisabled();
  await page.locator('[data-professional-attributes="unavailable"] [data-info-tip]').click();
  await expect(page.getByRole("tooltip")).toContainText("SCAP certifies professional attributes only for applications it has registered");
  await page.keyboard.press("Escape");

  await page.getByLabel("Reason", { exact: true }).fill("Approved for construction");
  await page.getByLabel("Location", { exact: true }).fill("Lisboa");
  await page.setInputFiles('input[type="file"]', IFC);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signedIfc = await downloadOutput(page, testInfo, 0);

  // The fields keep their text across a change of format.
  await selectIfczip(page);
  await expect(page.getByLabel("Reason", { exact: true })).toHaveValue("Approved for construction");
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
  const signedZip = await downloadOutput(page, testInfo, 0);
  expect(requests).toHaveLength(2);
  // IFCZIP: only SignedInfo reaches the companion, so the text does not.
  expect(requests[1].toString()).not.toContain("Lisboa");

  await page.goto("/sign/verify");
  await page.setInputFiles('input[type="file"]', [signedIfc.path, signedZip.path]);
  await expect(page.locator('[data-verify-status="verified"]')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('[data-signature-detail="reason"]')).toHaveText(["Reason:Approved for construction", "Reason:Approved for construction"]);
  await expect(page.locator('[data-signature-detail="location"]')).toHaveText(["Location:Lisboa", "Location:Lisboa"]);
  await expect(page.locator("[data-verify-results]")).toContainText("what the signer stated when signing");
});

test.describe("the Cartão de Cidadão time-stamp, through the companion", () => {
  test("stamps an IFCZIP signature from this machine, sending the companion a hash request and nothing else", async ({ page }, testInfo) => {
    const stamps: Buffer[] = [];
    await companion(page, "EC", { timestamp: "ok", remaining: 18, stamps });
    await page.goto("/sign/ifc");
    await selectIfczip(page);
    const option = page.locator('[data-timestamp-option][data-timestamp-source="cartao"]');
    const stampIt = option.getByLabel("Add a free time-stamp from the Cartão de Cidadão service");
    // The user's choice: off until ticked.
    await expect(stampIt).not.toBeChecked();
    await stampIt.check();
    await expect(option).toHaveAttribute("data-timestamp-budget", "18");
    // The help, with how many stamps are left, is behind the "i".
    await option.locator("[data-info-tip]").hover();
    await expect(page.getByRole("tooltip")).toContainText("allows 20 time-stamps in 20 minutes; 18 are left");

    await page.setInputFiles('input[type="file"]', IFC);
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('[data-timestamp-status="added"]')).toBeVisible();
    // One RFC 3161 request: a SHA-256 imprint and a nonce, nothing of the model.
    expect(stamps).toHaveLength(1);
    expect(stamps[0].length).toBeLessThan(80);
    expect(stamps[0].toString("latin1")).not.toMatch(/IFCWALL|ISO-10303/);

    const signed = await downloadOutput(page, testInfo, 0);
    await openVerifyFromLink(page);
    await page.setInputFiles('input[type="file"]', signed.path);
    await expect(page.locator('[data-verify-status="verified"]')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator("[data-verify-results]")).toContainText("Time-stamp:");
    await expect(page.locator("[data-verify-results]")).not.toContainText("No time-stamp");
  });

  test("offers both when the deployment has its own authority, the Cartão de Cidadão first", async ({ page }) => {
    await page.unroute("**/api/tsa");
    await page.route("**/api/tsa", (route) => route.fulfill({ json: { configured: true, name: "Test time-stamp authority" } }));
    await companion(page, "EC", { timestamp: "ok" });
    await page.goto("/sign/ifc");
    await selectIfczip(page);
    await expect(page.getByLabel("Add a time-stamp", { exact: true })).not.toBeChecked();
    await page.getByLabel("Add a time-stamp", { exact: true }).check();
    const source = page.getByRole("combobox", { name: "Time-stamp authority" });
    await expect(source).toContainText("Cartão de Cidadão (free, through the companion)");
    await source.click();
    await page.getByRole("option", { name: "Test time-stamp authority" }).click();
    await expect(page.locator("[data-timestamp-option]")).toHaveAttribute("data-timestamp-source", "server");
    await expect(page.locator("[data-timestamp-budget]")).toHaveCount(0);
  });

  test("warns before signing more than the budget allows, and keeps a signature the limit refused to stamp", async ({ page }) => {
    await companion(page, "EC", { timestamp: "limited", remaining: 0 });
    await page.goto("/sign/ifc");
    await selectIfczip(page);
    await page.setInputFiles('input[type="file"]', IFC);
    // Unticked, nothing to warn about; ticked, the budget is short.
    await expect(page.locator("[data-timestamp-budget-short]")).toHaveCount(0);
    await page.getByLabel("Add a free time-stamp from the Cartão de Cidadão service").check();
    await expect(page.locator("[data-timestamp-budget-short]")).toContainText("Only 0 of these 1 signatures can be time-stamped now");
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('[data-timestamp-status="failed"]')).toContainText(
      "the Cartão de Cidadão service's limit of 20 time-stamps in 20 minutes was reached",
    );
  });

  test("stamps a signature inside the IFC too (CAdES-T), and the verify page reads it", async ({ page }, testInfo) => {
    const stamps: Buffer[] = [];
    await companion(page, "EC", { timestamp: "ok", stamps });
    await openEmbedded(page);
    // Offered for the default format, no longer only for IFCZIP.
    const stampIt = page.getByLabel("Add a free time-stamp from the Cartão de Cidadão service");
    await expect(stampIt).not.toBeChecked();
    await page.setInputFiles('input[type="file"]', IFC);
    // Not ticked: signed, and nothing asked of the time-stamp service.
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator("[data-sign-output]")).toHaveCount(1, { timeout: 30000 });
    expect(stamps).toHaveLength(0);
    await expect(page.locator("[data-timestamp-status]")).toHaveCount(0);

    await stampIt.check();
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.locator('[data-timestamp-status="added"]')).toBeVisible({ timeout: 30000 });
    expect(stamps).toHaveLength(1);
    const signed = await downloadOutput(page, testInfo, 0);
    expect(signed.bytes.toString().match(/SIGNATURE;/g)).toHaveLength(1);

    await openVerifyFromLink(page);
    await page.setInputFiles('input[type="file"]', signed.path);
    await expect(page.locator("[data-embedded-verification]")).toContainText("Signature integrity verified", { timeout: 30000 });
    await expect(page.locator('[data-signature-detail="timestamp"]')).toContainText("Time-stamp:");
    await expect(page.locator('[data-signature-detail="timestamp"]')).not.toContainText("No time-stamp");
  });

  test("an older companion is asked to update, and nothing is offered", async ({ page }) => {
    await companion(page, "EC");
    await page.goto("/sign/ifc");
    await selectIfczip(page);
    await expect(page.locator("[data-companion-outdated]")).toContainText("Update the signing companion");
    await expect(page.locator("#ifc-sign-timestamp")).toHaveCount(0);
  });
});
