// @vitest-environment node

/**
 * Reason, place and certified attributes: signed with the signature in both
 * formats, read back only from what the signature covers, and never able to
 * make a signature invalid by being unreadable.
 */

import { unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new () => { window: { DOMParser: typeof DOMParser; close(): void } };
};
const dom = new JSDOM();
beforeAll(() => vi.stubGlobal("DOMParser", dom.window.DOMParser));
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

import { digest } from "../canonical";
import { prepareCms, verifyCms } from "../cms";
import { cosignContainer } from "../cosign";
import { oid, readNode, readOid } from "../der";
import { cleanDetail, cleanDetails, DETAIL_MAX_LENGTH, REASON_COMMITMENT_OID } from "../details";
import { scap } from "../professional-attributes";
import { createSoftwareSigningProvider } from "../providers/software";
import { signFiles } from "../sign";
import { verifyContainer } from "../verify";

const MODEL = new Uint8Array(readFileSync(new URL("../../../fixtures/ifc/georeferenced-wall-ifc4.ifc", import.meta.url)));
const author = await createSoftwareSigningProvider({ keyType: "RSA", subject: [["CN", "AUTHOR"], ["C", "PT"]] });
const reviewer = await createSoftwareSigningProvider({ keyType: "EC", subject: [["CN", "REVIEWER"], ["C", "PT"]] });

const signatureXml = (bytes: Uint8Array, file = "META-INF/signatures001.xml") =>
  new TextDecoder().decode(unzipSync(bytes)[file]);
function withSignatureXml(bytes: Uint8Array, xml: string, file = "META-INF/signatures001.xml") {
  const entries = unzipSync(bytes);
  entries[file] = new TextEncoder().encode(xml);
  return zipSync(entries);
}

describe("cleaning what the signer typed", () => {
  it("keeps one line of text, capped, and drops what is empty", () => {
    expect(cleanDetail("  Aprovação\n do\tprojeto  ")).toBe("Aprovação do projeto");
    expect(cleanDetail("a\u0000b")).toBe("a b");
    expect(cleanDetail("   ")).toBeUndefined();
    expect(cleanDetail("é".repeat(DETAIL_MAX_LENGTH + 10))).toHaveLength(DETAIL_MAX_LENGTH);
    // Capped by character, never through the middle of one.
    expect(Array.from(cleanDetail("🏗".repeat(DETAIL_MAX_LENGTH + 1))!)).toHaveLength(DETAIL_MAX_LENGTH);
    expect(cleanDetails({ reason: " ", location: "" })).toBeUndefined();
    expect(cleanDetails({ reason: "Revisão", location: " " })).toEqual({ reason: "Revisão" });
  });

  it("encodes the reason's 128-bit UUID arc without rounding it", () => {
    const node = readNode(oid(REASON_COMMITMENT_OID));
    expect(readOid(node.content)).toBe(REASON_COMMITMENT_OID);
    // An ordinary OID is unchanged by the BigInt path.
    expect(readOid(readNode(oid("1.2.840.113549.1.9.16.2.47")).content)).toBe("1.2.840.113549.1.9.16.2.47");
  });
});

describe("in an IFCZIP (XAdES)", () => {
  const details = { reason: "Aprovação do projeto & <revisão>", location: "Lisboa" };

  it("signs the reason and place, and the verifier reads them back", async () => {
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, { details });
    const [signature] = (await verifyContainer(signed.bytes)).signatures;
    expect(signature.valid).toBe(true);
    expect(signature.details).toEqual(details);

    // In the schema's order, inside SignedProperties.
    const xml = signatureXml(signed.bytes);
    const order = ["SigningTime", "SigningCertificateV2", "SignatureProductionPlaceV2", "DataObjectFormat", "CommitmentTypeIndication"]
      .map((name) => xml.indexOf(`<xades:${name}`));
    expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]))).toBe(true);
    expect(xml).toContain(`urn:oid:${REASON_COMMITMENT_OID}`);
    expect(xml).toContain("<xades:AllSignedDataObjects></xades:AllSignedDataObjects>");
  });

  it("adds nothing when nothing was stated", async () => {
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, { details: { reason: "  " } });
    const xml = signatureXml(signed.bytes);
    expect(xml).not.toContain("CommitmentTypeIndication");
    expect(xml).not.toContain("SignatureProductionPlace");
    expect((await verifyContainer(signed.bytes)).signatures[0].details).toBeUndefined();
  });

  it("breaks the signature when a stated place is changed afterwards", async () => {
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, { details });
    const altered = withSignatureXml(signed.bytes, signatureXml(signed.bytes).replace(">Lisboa<", ">Porto<"));
    const [signature] = (await verifyContainer(altered)).signatures;
    expect(signature.valid).toBe(false);
    // Read only from SignedProperties a matching Reference covers: nothing shown.
    expect(signature.details).toBeUndefined();
  });

  it("ignores a place slipped in outside what was signed", async () => {
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author);
    const xml = signatureXml(signed.bytes).replace(
      "</xades:QualifyingProperties>",
      "<xades:UnsignedProperties><xades:SignatureProductionPlaceV2><xades:City>Porto</xades:City></xades:SignatureProductionPlaceV2></xades:UnsignedProperties></xades:QualifyingProperties>",
    );
    const [signature] = (await verifyContainer(withSignatureXml(signed.bytes, xml))).signatures;
    expect(signature.valid).toBe(true);
    expect(signature.details).toBeUndefined();
  });

  it("gives each co-signer their own reason", async () => {
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, {
      mode: "per-file", details: { reason: "Autoria", location: "Porto" },
    });
    const twice = await cosignContainer({ name: signed.name, bytes: signed.bytes }, reviewer, {
      details: { reason: "Revisão e aprovação" },
    });
    const { signatures } = await verifyContainer(twice.bytes);
    expect(signatures.map((signature) => [signature.valid, signature.details])).toEqual([
      [true, { reason: "Autoria", location: "Porto" }],
      [true, { reason: "Revisão e aprovação" }],
    ]);
  });

  it("carries a certified attribute's assertion as received, and only counts it", async () => {
    const assertion = btoa("<saml:Assertion>issued by a professional order</saml:Assertion>");
    const [signed] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author, {
      details: { professionalAttributes: [{ description: "Engenheiro civil", issuer: "Ordem dos Engenheiros", assertion }] },
    });
    const xml = signatureXml(signed.bytes);
    expect(xml).toContain(`<xades:SignerRoleV2><xades:SignedAssertions><xades:SignedAssertion>${assertion}</xades:SignedAssertion>`);
    const [signature] = (await verifyContainer(signed.bytes)).signatures;
    expect(signature.valid).toBe(true);
    expect(signature.details).toEqual({ certifiedAttributes: 1 });
  });

  it("has no source for certified attributes until ADR 019 is accepted", async () => {
    expect(await scap.availability()).toEqual({ available: false, reason: "not-configured" });
    await expect(scap.attributesFor(await author.getSigningCertificate())).rejects.toMatchObject({ code: "not-configured" });
  });
});

describe("inside an IFC (CMS)", () => {
  async function cms(details?: { reason?: string; location?: string }) {
    const certificate = await reviewer.getSigningCertificate();
    const contentDigest = await digest("SHA-256", MODEL);
    const prepared = await prepareCms(contentDigest, certificate, new Date(), details);
    const result = await reviewer.sign({
      dataToBeSigned: prepared.dataToBeSigned, hash: prepared.hash, expectCertificateDer: certificate.certificateDer,
    });
    return { bytes: prepared.complete(result), contentDigest };
  }

  it("signs the reason and place as CAdES attributes, and reads them back", async () => {
    const { bytes, contentDigest } = await cms({ reason: "Aprovação", location: "Coimbra" });
    expect(await verifyCms(bytes, contentDigest)).toMatchObject({
      valid: true, details: { reason: "Aprovação", location: "Coimbra" },
    });
  });

  it("states nothing when nothing was given", async () => {
    const { bytes, contentDigest } = await cms();
    const result = await verifyCms(bytes, contentDigest);
    expect(result.valid).toBe(true);
    expect(result.details).toBeUndefined();
  });
});
