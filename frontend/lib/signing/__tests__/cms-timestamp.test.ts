// @vitest-environment node

/**
 * CAdES-T inside an IFC: the time-stamp covers the SignerInfo's signature value
 * as stored, sits in `unsignedAttrs`, and is checked against that value. Any
 * other unsigned attribute still fails closed.
 */

import { describe, expect, it } from "vitest";

import { digest } from "../canonical";
import { prepareCms, verifyCms } from "../cms";
import { oid, readChildren, readNode } from "../der";
import { createSoftwareSigningProvider } from "../providers/software";
import { buildTimestampRequest, parseTimestampResponse, randomNonce } from "../timestamp";
import { fakeTimestampResponse } from "./fake-tsa";

const CONTENT = new Uint8Array(32).fill(7);

/** A token from the stand-in authority for `hash`. */
function stamp(hash: Uint8Array): Uint8Array {
  const reply = parseTimestampResponse(fakeTimestampResponse(buildTimestampRequest({ digest: hash, nonce: randomNonce() })));
  if (!reply.granted) throw new Error(reply.reason);
  return reply.token;
}

async function signed(keyType: "RSA" | "EC") {
  const provider = await createSoftwareSigningProvider({ keyType, subject: [["CN", "SIGNER"], ["C", "PT"]] });
  const certificate = await provider.getSigningCertificate();
  const prepared = await prepareCms(CONTENT, certificate);
  const result = await provider.sign({
    dataToBeSigned: prepared.dataToBeSigned, hash: prepared.hash, expectCertificateDer: certificate.certificateDer,
  });
  return { prepared, result, certificate };
}

/** The SignerInfo's signature value, as a verifier finds it. */
function storedSignature(cms: Uint8Array): Uint8Array {
  const signedData = readChildren(readChildren(readChildren(readNode(cms))[1])[0]);
  const signerInfo = readChildren(readChildren(signedData[4])[0]);
  return signerInfo[5].content;
}

describe("a time-stamp inside an IFC (CAdES-T)", () => {
  for (const keyType of ["RSA", "EC"] as const) {
    it(`stamps the ${keyType} signature value as stored, and verifies it`, async () => {
      const { prepared, result } = await signed(keyType);
      const hash = await prepared.timestampDigest(result);
      const cms = prepared.complete(result, { timestampToken: stamp(hash) });

      // The hash is of the stored value (DER for ECDSA), which a verifier reads back.
      expect(hash).toEqual(await digest("SHA-256", storedSignature(cms)));
      expect(await verifyCms(cms, CONTENT)).toMatchObject({
        valid: true,
        timestamp: { matches: true, time: "2026-10-12T09:30:00.000Z", problems: [] },
      });
    });
  }

  it("is absent when none was asked for", async () => {
    const { prepared, result } = await signed("EC");
    const verified = await verifyCms(prepared.complete(result), CONTENT);
    expect(verified.valid).toBe(true);
    expect(verified.timestamp).toBeUndefined();
  });

  it("reports a token for another signature, and the signature stays valid", async () => {
    const { prepared, result } = await signed("EC");
    const cms = prepared.complete(result, { timestampToken: stamp(new Uint8Array(32)) });
    const verified = await verifyCms(cms, CONTENT);
    expect(verified.valid).toBe(true);
    expect(verified.timestamp).toMatchObject({ matches: false });
    expect(verified.timestamp?.problems.join(" ")).toMatch(/different signature value/);
  });

  it("still fails closed on any other unsigned attribute", async () => {
    const { prepared, result } = await signed("RSA");
    const cms = prepared.complete(result, { timestampToken: stamp(await prepared.timestampDigest(result)) });
    // Swap the time-stamp attribute's OID for another: same shape, unknown meaning.
    const tsOid = oid("1.2.840.113549.1.9.16.2.14");
    const other = oid("1.2.840.113549.1.9.16.2.99");
    const at = indexOf(cms, tsOid);
    expect(at).toBeGreaterThan(0);
    const altered = new Uint8Array(cms);
    altered.set(other, at);
    expect((await verifyCms(altered, CONTENT)).valid).toBe(false);
  });

  it("will not hash a result from another card for a time-stamp", async () => {
    const { prepared, result } = await signed("EC");
    const otherCard = await createSoftwareSigningProvider({ keyType: "EC" });
    const other = (await otherCard.getSigningCertificate()).certificateDer;
    await expect(prepared.timestampDigest({ ...result, certificateDer: other })).rejects.toMatchObject({ code: "card-changed" });
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
