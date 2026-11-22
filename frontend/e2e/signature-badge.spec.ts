import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

import { unzipSync, zipSync } from "fflate";

import { digest } from "../lib/signing/canonical";
import { prepareCms } from "../lib/signing/cms";
import { cosignContainer } from "../lib/signing/cosign";
import { appendEmbeddedSignature, inspectEmbeddedIfc } from "../lib/signing/embedded-format";
import { createSoftwareSigningProvider } from "../lib/signing/providers/software";
import { signFiles } from "../lib/signing/sign";

/**
 * The signature result in the viewer's model list.
 *
 * A container signed here with a real (software) key, so no card is needed:
 * the badge reads what verification found. What a "valid" does not cover is on
 * the About page, not repeated here.
 */

const WALL = path.resolve(__dirname, "../fixtures/ifc/georeferenced-wall-ifc4.ifc");

// Signing parses the XML it builds, which needs a DOMParser; Node has none and the
// browser under test is a different process. jsdom's is enough for that.
const { JSDOM } = createRequire(__filename)("jsdom") as { JSDOM: new () => { window: { DOMParser: unknown } } };
(globalThis as { DOMParser?: unknown }).DOMParser ??= new JSDOM().window.DOMParser;

async function signedContainer(testInfo: import("@playwright/test").TestInfo) {
  const [output] = await signFiles(
    [{ name: "wall.ifc", bytes: new Uint8Array(fs.readFileSync(WALL)) }],
    await createSoftwareSigningProvider({ keyType: "EC" }),
  );
  const file = testInfo.outputPath("wall.ifczip");
  fs.writeFileSync(file, output.bytes);
  return file;
}

test.describe("one signature", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.goto("/viewer");
    await page.setInputFiles('input[type="file"]', [await signedContainer(testInfo)]);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
    await page.getByRole("tab", { name: /models|modelos/i }).click();
  });

  test("the model list shows the result and signer, and not the caveat under it", async ({ page }) => {
    const status = page.locator("[data-signature-status]").first();
    await expect(status).toContainText(/Signature valid/);

    // The row says what was found. What "valid" does and does not cover is on the
    // About page, once — not under every model.
    await expect(page.getByText(/qualified status are not checked/)).toHaveCount(0);
    await expect(page.getByText(/unchanged since it was signed/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /signature check covers/i })).toHaveCount(0);
    await expect(page.locator("[data-signature-caveat]")).toHaveCount(0);
  });

  test("reads in Portuguese", async ({ page, context }, testInfo) => {
    await context.addCookies([
      { name: "dice-locale", value: "pt", url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}` },
    ]);
    await page.reload();
    await page.setInputFiles('input[type="file"]', [await signedContainer(testInfo)]);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
    await page.getByRole("tab", { name: /modelos/i }).click();

    await expect(page.locator("[data-signature-status]").first()).toContainText(/Assinatura válida/);
    await expect(page.getByText(/não são verificadas/)).toHaveCount(0);
  });
});

/**
 * A co-signed file lists every signer, in the file's order, and each is marked:
 * a broken co-signature is pointed at, not just counted.
 */
test.describe("several signatures", () => {
  const signer = (cn: string, keyType: "RSA" | "EC") =>
    createSoftwareSigningProvider({ keyType, subject: [["CN", cn], ["C", "PT"]] });

  async function cosigned(testInfo: import("@playwright/test").TestInfo, breakSecond = false) {
    const [authored] = await signFiles(
      [{ name: "wall.ifc", bytes: new Uint8Array(fs.readFileSync(WALL)) }],
      await signer("AUTHOR", "RSA"),
    );
    const output = await cosignContainer(authored, await signer("REVIEWER", "EC"));
    let bytes = output.bytes;
    if (breakSecond) {
      // Change one character of the reviewer's SignatureValue: the author's still verifies.
      const entries = unzipSync(bytes);
      const xml = new TextDecoder().decode(entries["META-INF/signatures002.xml"]);
      const at = xml.indexOf("<ds:SignatureValue");
      const start = xml.indexOf(">", at) + 1;
      entries["META-INF/signatures002.xml"] = new TextEncoder().encode(
        xml.slice(0, start) + (xml[start] === "A" ? "B" : "A") + xml.slice(start + 1),
      );
      bytes = zipSync(entries);
    }
    const file = testInfo.outputPath(breakSecond ? "wall-broken.ifczip" : "wall-cosigned.ifczip");
    fs.writeFileSync(file, bytes);
    return file;
  }

  async function embeddedTwice(testInfo: import("@playwright/test").TestInfo) {
    let bytes: Uint8Array = new Uint8Array(fs.readFileSync(WALL));
    for (const provider of [await signer("AUTHOR", "RSA"), await signer("REVIEWER", "EC")]) {
      const { normalized } = inspectEmbeddedIfc(bytes);
      const certificate = await provider.getSigningCertificate();
      const prepared = await prepareCms(await digest("SHA-256", normalized), certificate);
      const result = await provider.sign({
        dataToBeSigned: prepared.dataToBeSigned, hash: prepared.hash, expectCertificateDer: certificate.certificateDer,
      });
      bytes = appendEmbeddedSignature(bytes, prepared.complete(result));
    }
    const file = testInfo.outputPath("wall-cosigned.ifc");
    fs.writeFileSync(file, bytes);
    return file;
  }

  async function open(page: import("@playwright/test").Page, ...files: string[]) {
    await page.goto("/viewer");
    await page.setInputFiles('input[type="file"]', files);
    await expect(page.locator('[data-geometry-ready="true"]')).toBeAttached({ timeout: 60_000 });
    await page.getByRole("tab", { name: /models|modelos/i }).click();
  }

  test("an IFCZIP shows both signers, author first", async ({ page }, testInfo) => {
    await open(page, await cosigned(testInfo));
    await expect(page.locator("[data-signature-status]")).toContainText("All signatures valid — 2 signers");
    const rows = page.locator("[data-signer]");
    await expect(rows).toHaveText([/^AUTHOR/, /^REVIEWER/]);
    await expect(rows.and(page.locator('[data-valid="true"]'))).toHaveCount(2);
    // Parallel signatures: no signing-order note.
    await expect(page.locator("[data-signature-chain]")).toHaveCount(0);
  });

  test("marks the one signature that fails", async ({ page }, testInfo) => {
    await open(page, await cosigned(testInfo, true));
    await expect(page.locator("[data-signature-status]")).toContainText("1 of 2 signatures not valid");
    await expect(page.locator('[data-signer][data-valid="true"]')).toHaveText([/^AUTHOR/]);
    await expect(page.locator('[data-signer][data-valid="false"]')).toHaveText([/^REVIEWER/]);
  });

  test("an IFC signed twice inside says each signature covers the ones before", async ({ page }, testInfo) => {
    await open(page, await embeddedTwice(testInfo));
    await expect(page.locator("[data-signature-status]")).toContainText("All signatures valid — 2 signers");
    await expect(page.locator("[data-signer]")).toHaveText([/^AUTHOR/, /^REVIEWER/]);
    await expect(page.locator("[data-signature-chain]")).toContainText(/covers the ones above it/);
  });

  test("two copies of one model, opened together, keep their own results", async ({ page }, testInfo) => {
    // Both wrap `wall.ifc`; their ids once collided across the worker pool and
    // each check's result landed on both rows.
    await open(page, await cosigned(testInfo), await cosigned(testInfo, true));
    await expect(page.locator("[data-signature-status]")).toHaveCount(2);
    const row = (name: string) => page.locator("li", { hasText: name }).filter({ has: page.locator("[data-signature-status]") });
    await expect(row("wall-cosigned.ifczip").locator("[data-signature-status]")).toContainText("All signatures valid — 2 signers");
    await expect(row("wall-broken.ifczip").locator("[data-signature-status]")).toContainText("1 of 2 signatures not valid");
  });

  test("each signer's stated reason and place sit under their name", async ({ page }, testInfo) => {
    const [authored] = await signFiles(
      [{ name: "wall.ifc", bytes: new Uint8Array(fs.readFileSync(WALL)) }],
      await signer("AUTHOR", "RSA"),
      { details: { reason: "Authorship", location: "Porto" } },
    );
    const output = await cosignContainer(authored, await signer("REVIEWER", "EC"), { details: { reason: "Approved" } });
    const file = testInfo.outputPath("wall-stated.ifczip");
    fs.writeFileSync(file, output.bytes);
    await open(page, file);
    await expect(page.locator("[data-signer-details]")).toHaveText(["Authorship · Porto", "Approved"]);
    await expect(page.locator("[data-signer-details]").first()).toHaveAttribute("title", "Reason: Authorship\nLocation: Porto");
  });
});
