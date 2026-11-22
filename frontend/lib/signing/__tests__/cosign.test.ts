// @vitest-environment node

/**
 * Co-signing, with real keys: an author signs, a reviewer adds a signature, and
 * every refusal happens before the reviewer's card is asked to sign.
 */

import { unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// As in roundtrip.test.ts: Node's WebCrypto, jsdom's DOMParser only.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new () => { window: { DOMParser: typeof DOMParser; close(): void } };
};
const dom = new JSDOM();
beforeAll(() => vi.stubGlobal("DOMParser", dom.window.DOMParser));
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

import { addSignature, listSignatureFiles } from "../asice";
import { digest } from "../canonical";
import { prepareCms, verifyCms } from "../cms";
import { checkExistingSignatures, checkNotAlreadySigner, cosignContainer, MAX_EMBEDDED_SIGNATURES } from "../cosign";
import { appendEmbeddedSignature, inspectEmbeddedIfc } from "../embedded-format";
import type { SigningProvider } from "../provider";
import { createSoftwareSigningProvider } from "../providers/software";
import { signFiles } from "../sign";
import { verifyContainer } from "../verify";

const MODEL = new Uint8Array(readFileSync(new URL("../../../fixtures/ifc/georeferenced-wall-ifc4.ifc", import.meta.url)));

/** A provider whose card use is counted, so a refusal can be shown to cost no PIN. */
function watched(provider: SigningProvider) {
  return {
    ...provider,
    getSigningCertificate: vi.fn(provider.getSigningCertificate.bind(provider)),
    sign: vi.fn(provider.sign.bind(provider)),
  };
}

const author = await createSoftwareSigningProvider({ keyType: "RSA", subject: [["CN", "AUTHOR"], ["C", "PT"]] });
const reviewer = await createSoftwareSigningProvider({ keyType: "EC", subject: [["CN", "REVIEWER"], ["C", "PT"]] });
const coordinator = await createSoftwareSigningProvider({ keyType: "RSA", subject: [["CN", "COORDINATOR"], ["C", "PT"]] });

async function signedByAuthor() {
  const [container] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, { mode: "per-file" });
  return { name: container.name, bytes: container.bytes };
}

describe("co-signing an IFCZIP", () => {
  it("adds the reviewer's signature beside the author's, leaving both and the model untouched", async () => {
    const file = await signedByAuthor();
    const output = await cosignContainer(file, reviewer);

    expect(output.name).toBe("model.ifczip");
    expect(output.covers).toEqual(["model.ifc"]);
    const before = unzipSync(file.bytes);
    const after = unzipSync(output.bytes);
    expect(listSignatureFiles(after)).toEqual(["META-INF/signatures001.xml", "META-INF/signatures002.xml"]);
    expect(after["model.ifc"]).toEqual(MODEL);
    expect(after["META-INF/signatures001.xml"]).toEqual(before["META-INF/signatures001.xml"]);
    // The ASiC rule still holds: mimetype first.
    expect(Object.keys(after)[0]).toBe("mimetype");

    const result = await verifyContainer(output.bytes);
    expect(result.signatures.map((signature) => [signature.subject.includes("AUTHOR") || signature.subject.includes("REVIEWER"), signature.valid]))
      .toEqual([[true, true], [true, true]]);
  });

  it("takes a third signer, and the signatures stay independent", async () => {
    const twice = await cosignContainer(await signedByAuthor(), reviewer);
    const thrice = await cosignContainer(twice, coordinator);
    const entries = unzipSync(thrice.bytes);
    expect(listSignatureFiles(entries)).toHaveLength(3);

    // Parallel: drop the reviewer's and the other two still verify.
    delete entries["META-INF/signatures002.xml"];
    const result = await verifyContainer(zipSync(entries));
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures.every((signature) => signature.valid)).toBe(true);
  });

  it("co-signs with a Cartão de Cidadão v2's pairing, P-256 with SHA-512, and verifies it", async () => {
    // The companion negotiates ES512 for an EC card. The verifier once guessed
    // the curve from the hash (SHA-512 → P-521) and failed every such signature.
    const cardV2 = await createSoftwareSigningProvider({ keyType: "EC", algorithm: "ES512", subject: [["CN", "CC V2"], ["C", "PT"]] });
    const output = await cosignContainer(await signedByAuthor(), cardV2);
    const result = await verifyContainer(output.bytes);
    expect(result.signatures.map((signature) => [signature.algorithm, signature.valid])).toEqual([
      ["RSA-SHA-256", true],
      ["ECDSA-SHA-512", true],
    ]);
  });

  it("refuses an unsigned archive before reading the card", async () => {
    const device = watched(reviewer);
    await expect(cosignContainer({ name: "model.ifczip", bytes: zipSync({ "model.ifc": MODEL }) }, device))
      .rejects.toMatchObject({ name: "CosignError", code: "not-signed" });
    expect(device.getSigningCertificate).not.toHaveBeenCalled();
    expect(device.sign).not.toHaveBeenCalled();
  });

  it("refuses a model altered after it was signed, before reading the card", async () => {
    const entries = unzipSync((await signedByAuthor()).bytes);
    entries["model.ifc"] = new TextEncoder().encode(new TextDecoder().decode(MODEL).replace("IFCWALL", "IFCSLAB"));
    const device = watched(reviewer);
    await expect(cosignContainer({ name: "model.ifczip", bytes: zipSync(entries) }, device))
      .rejects.toMatchObject({ code: "existing-invalid" });
    expect(device.getSigningCertificate).not.toHaveBeenCalled();
  });

  it("refuses a file slipped into the container after it was signed", async () => {
    const entries = unzipSync((await signedByAuthor()).bytes);
    entries["extra.ifc"] = MODEL;
    const device = watched(reviewer);
    await expect(cosignContainer({ name: "model.ifczip", bytes: zipSync(entries) }, device))
      .rejects.toMatchObject({ code: "uncovered-payload" });
    expect(device.sign).not.toHaveBeenCalled();
  });

  it("refuses a second signature from the same card, before the PIN", async () => {
    const device = watched(author);
    await expect(cosignContainer(await signedByAuthor(), device)).rejects.toMatchObject({ code: "already-signer" });
    expect(device.getSigningCertificate).toHaveBeenCalled();
    expect(device.sign).not.toHaveBeenCalled();
  });

  it("numbers past the highest signature, so a gap never overwrites one", async () => {
    const twice = await cosignContainer(await signedByAuthor(), reviewer);
    const entries = unzipSync(twice.bytes);
    entries["META-INF/signatures003.xml"] = entries["META-INF/signatures002.xml"];
    delete entries["META-INF/signatures002.xml"];
    const gapped = zipSync(entries);
    const added = addSignature(gapped, "<ds:Signature/>");
    const after = unzipSync(added);
    expect(listSignatureFiles(after)).toEqual([
      "META-INF/signatures001.xml",
      "META-INF/signatures003.xml",
      "META-INF/signatures004.xml",
    ]);
    expect(after["META-INF/signatures003.xml"]).toEqual(entries["META-INF/signatures003.xml"]);
  });
});

/**
 * The embedded chain at the format level: what `embedded-signing.worker.ts`
 * does, with the same functions. The worker itself needs a browser; the e2e
 * test runs it through the page.
 */
describe("co-signing inside an IFC", () => {
  async function appendSignature(bytes: Uint8Array, provider: SigningProvider) {
    const { normalized } = inspectEmbeddedIfc(bytes);
    const certificate = await provider.getSigningCertificate();
    const prepared = await prepareCms(await digest("SHA-256", normalized), certificate);
    const result = await provider.sign({
      dataToBeSigned: prepared.dataToBeSigned, hash: prepared.hash, expectCertificateDer: certificate.certificateDer,
    });
    return appendEmbeddedSignature(bytes, prepared.complete(result));
  }

  async function verifyAll(bytes: Uint8Array) {
    const { normalized, blocks } = inspectEmbeddedIfc(bytes);
    return Promise.all(blocks.map(async (block) =>
      (await verifyCms(block.cms, await digest("SHA-256", normalized.subarray(0, block.start)))).valid));
  }

  it("chains: the reviewer's signature covers the model and the author's signature", async () => {
    const once = await appendSignature(MODEL, author);
    const twice = await appendSignature(once, reviewer);

    expect(twice.subarray(0, once.length)).toEqual(once);
    expect(await verifyAll(twice)).toEqual([true, true]);

    // Damage the author's signature: both fail, because the reviewer signed it too.
    const text = new TextDecoder().decode(twice);
    const first = text.indexOf("SIGNATURE;") + "SIGNATURE;\n".length;
    const flipped = text.slice(0, first) + (text[first] === "M" ? "N" : "M") + text.slice(first + 1);
    expect(await verifyAll(new TextEncoder().encode(flipped))).toEqual([false, false]);
  });
});

describe("the checks both formats share", () => {
  const ok = { subject: "CN=AUTHOR", issuer: "CN=AUTHOR", serial: "1", valid: true };

  it("needs a signature, every one valid, and room for another", () => {
    expect(() => checkExistingSignatures([])).toThrow("not-signed");
    expect(() => checkExistingSignatures([ok, { ...ok, valid: false }])).toThrow("existing-invalid");
    expect(() => checkExistingSignatures(Array(MAX_EMBEDDED_SIGNATURES).fill(ok), MAX_EMBEDDED_SIGNATURES))
      .toThrow("too-many-signatures");
    expect(() => checkExistingSignatures([ok], MAX_EMBEDDED_SIGNATURES)).not.toThrow();
  });

  it("knows a signer by the certificate's issuer and serial", async () => {
    const certificate = await author.getSigningCertificate();
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author);
    const { signatures } = await verifyContainer(signed.bytes);
    const other = (await reviewer.getSigningCertificate()).certificateDer;
    expect(() => checkNotAlreadySigner(signatures, certificate.certificateDer)).toThrow("already-signer");
    expect(() => checkNotAlreadySigner(signatures, other)).not.toThrow();
  });
});
