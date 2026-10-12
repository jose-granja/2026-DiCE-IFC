import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64, digest, utf8 } from "../canonical";
import { prepareCms, verifyCms } from "../cms";
import { appendEmbeddedSignature, inspectEmbeddedIfc, normalizeIfc } from "../embedded-format";
import { createSoftwareSigningProvider } from "../providers/software";
import { readNode } from "../der";

const fixture = new Uint8Array(readFileSync(new URL("../../../fixtures/ifc/georeferenced-wall-ifc4.ifc", import.meta.url)));
const source = new TextDecoder().decode(fixture);
const temp = mkdtempSync(join(tmpdir(), "dice-embedded-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const openssl = spawnSync("openssl", ["version"]).status === 0;

describe("embedded IFC signature framing", () => {
  it("matches buildingSMART normalization, preserving spaces and STEP escapes", () => {
    expect(new TextDecoder().decode(normalizeIfc(utf8(" A\r\n\tB \x7f\\X2\\00E7\\X0\\"))))
      .toBe(" AB \\X2\\00E7\\X0\\");
    expect(() => normalizeIfc(utf8("José"))).toThrow("non-ascii");
    expect(inspectEmbeddedIfc(fixture).blocks).toHaveLength(0);
  });
  it("does not treat markers in quoted IFC values as signature comments or sections", () => {
    const tricky = source.replace("'Fixture'", "'A '' name /*SIGNATURE;badENDSEC;*/ END-ISO-10303-21;'");
    expect(inspectEmbeddedIfc(utf8(tricky)).blocks).toHaveLength(0);
  });
  it.each(["garbage", source.replace("IFC4", "OTHER"), source.replace("END-ISO-10303-21;", ""),
    source + "#99=IFCWALL();", source.replace("DATA;", "SIGNATURE;")])("refuses a non-IFC or broken envelope", (text) => {
    expect(() => inspectEmbeddedIfc(utf8(text))).toThrow("invalid-ifc");
  });
  it("rejects unsigned additions after a signature, even whitespace retained by the format", () => {
    const signed = appendEmbeddedSignature(fixture, Uint8Array.of(1, 2, 3));
    for (const suffix of [" ", "/*extra*/", "#99=IFCWALL();"]) {
      expect(() => inspectEmbeddedIfc(utf8(new TextDecoder().decode(signed) + suffix))).toThrow("invalid-signature");
    }
  });
  it("rejects truncated DER lengths without looping", () => {
    for (const data of [[], [0x30], [0x30, 0x84, 0xff, 0xff, 0xff, 0xff], [0x30, 0x80], [0x30, 5, 1]]) {
      expect(() => readNode(Uint8Array.from(data))).toThrow();
    }
  });
});

describe.each(["RSA", "EC"] as const)("CMS with a real %s key", (keyType) => {
  it("preserves the original file and detects tampering, and OpenSSL verifies the result", async () => {
    const provider = await createSoftwareSigningProvider({ keyType });
    const certificate = await provider.getSigningCertificate();
    const normalized = normalizeIfc(fixture);
    const hash = await digest("SHA-256", normalized);
    const prepared = await prepareCms(hash, certificate, new Date("2026-10-12T12:00:00Z"));
    expect(prepared.dataToBeSigned.length).toBeLessThan(512);
    expect(new TextDecoder().decode(prepared.dataToBeSigned)).not.toContain("IFCWALL");
    const result = await provider.sign({ dataToBeSigned: prepared.dataToBeSigned, hash: prepared.hash,
      expectCertificateDer: certificate.certificateDer });
    const cms = prepared.complete(result);
    const signed = appendEmbeddedSignature(fixture, cms);
    expect(signed.subarray(0, fixture.length)).toEqual(fixture);
    const parsed = inspectEmbeddedIfc(signed);
    expect(parsed.blocks).toHaveLength(1);
    const checked = await verifyCms(parsed.blocks[0].cms,
      await digest("SHA-256", parsed.normalized.subarray(0, parsed.blocks[0].start)));
    expect(checked.valid).toBe(true);
    expect(checked.certificate?.subject).toBe(certificate.subject);
    expect(checked.signingTime).toBe("2026-10-12T12:00:00Z");
    expect((await verifyCms(cms, await digest("SHA-256", normalizeIfc(utf8(source.replace("IFCWALL", "IFCSLAB")))))).valid).toBe(false);
    expect((await verifyCms(cms, await digest("SHA-256", normalizeIfc(utf8(source.replaceAll("\n", "\r\n")))))).valid).toBe(true);
    expect((await verifyCms(cms.subarray(0, cms.length - 1), hash)).valid).toBe(false);
    const damaged = cms.slice(); damaged[damaged.length - 1] ^= 1;
    expect((await verifyCms(damaged, hash)).valid).toBe(false);
    expect(() => prepared.complete({ ...result, certificateDer: base64(Uint8Array.of(1)) })).toThrow("certificate changed");
    expect(() => prepared.complete({ ...result, algorithm: "RS512" })).toThrow("algorithm");
    if (openssl) {
      writeFileSync(join(temp, `${keyType}.der`), cms);
      writeFileSync(join(temp, "content"), normalized);
      execFileSync("openssl", ["cms", "-verify", "-binary", "-inform", "DER", "-in", join(temp, `${keyType}.der`),
        "-content", join(temp, "content"), "-noverify", "-out", join(temp, "verified")], { stdio: "pipe" });
      expect(readFileSync(join(temp, "verified"))).toEqual(Buffer.from(normalized));
    }
  });
});

it.skipIf(!openssl)("verifies independent OpenSSL CMS (including extra S/MIME attributes)", async () => {
  const key = join(temp, "key.pem"), cert = join(temp, "cert.pem"), content = join(temp, "external-content"), signature = join(temp, "external.der");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=CMS interoperability test", "-keyout", key, "-out", cert], { stdio: "pipe" });
  const normalized = normalizeIfc(fixture);
  writeFileSync(content, normalized);
  execFileSync("openssl", ["cms", "-sign", "-binary", "-md", "sha256", "-in", content, "-signer", cert, "-inkey", key,
    "-outform", "DER", "-out", signature], { stdio: "pipe" });
  const result = await verifyCms(new Uint8Array(readFileSync(signature)), await digest("SHA-256", normalized));
  expect(result.valid).toBe(true);
  expect(result.certificate?.subject).toContain("CMS interoperability test");
});
