import { describe, expect, it } from "vitest";

import {
  SigningError,
  hashForAlgorithm,
  negotiateAlgorithm,
  xmldsigAlgorithmUri,
  xmldsigDigestUri,
  type SigningCertificate,
} from "../provider";
import { createMockSigningProvider } from "../providers/mock";

function certificate(
  overrides: Partial<SigningCertificate> = {},
): SigningCertificate {
  return {
    certificateDer: "",
    chainDer: [],
    subject: "CN=Test, C=PT",
    issuer: "CN=Test CA, C=PT",
    serial: "01",
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2031-01-01T00:00:00.000Z",
    keyType: "RSA",
    supportedAlgorithms: ["RS256"],
    ...overrides,
  };
}

describe("algorithm negotiation", () => {
  it("picks ECDSA for a CC v2 card without being told the card version", () => {
    const { algorithm, hash } = negotiateAlgorithm(
      certificate({ keyType: "EC", supportedAlgorithms: ["ES256", "ES384"] }),
    );
    expect(algorithm).toBe("ES384");
    expect(hash).toBe("SHA-384");
  });

  it("picks RSA for a CC v1 card", () => {
    const { algorithm, hash } = negotiateAlgorithm(
      certificate({ keyType: "RSA", supportedAlgorithms: ["RS256"] }),
    );
    expect(algorithm).toBe("RS256");
    expect(hash).toBe("SHA-256");
  });

  it("prefers the strongest algorithm the device actually offers", () => {
    expect(
      negotiateAlgorithm(
        certificate({ supportedAlgorithms: ["RS256", "RS512"] }),
      ).algorithm,
    ).toBe("RS512");
  });

  it("prefers PSS over PKCS#1 v1.5 when both are offered", () => {
    expect(
      negotiateAlgorithm(
        certificate({ supportedAlgorithms: ["RS512", "PS256"] }),
      ).algorithm,
    ).toBe("PS256");
  });

  it("refuses rather than guessing when nothing is recognised", () => {
    expect(() =>
      negotiateAlgorithm(certificate({ supportedAlgorithms: [] })),
    ).toThrow(SigningError);
  });

  it("maps every algorithm to a XMLDSig URI and a digest URI", () => {
    for (const algorithm of [
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "ES256",
      "ES384",
      "ES512",
    ] as const) {
      expect(xmldsigAlgorithmUri(algorithm)).toMatch(/^http/);
      expect(xmldsigDigestUri(hashForAlgorithm(algorithm))).toMatch(/^http/);
    }
  });
});

describe("mock signing provider", () => {
  it("is always ready", async () => {
    const provider = createMockSigningProvider();
    expect((await provider.getReadiness()).ready).toBe(true);
  });

  it("signs deterministically, so container assembly can be asserted on", async () => {
    const provider = createMockSigningProvider();
    const cert = await provider.getSigningCertificate();
    const request = {
      dataToBeSigned: new TextEncoder().encode("<SignedInfo/>"),
      hash: "SHA-384" as const,
      expectCertificateDer: cert.certificateDer,
    };

    const first = await provider.sign(request);
    const second = await provider.sign(request);
    expect(first.signatureValue).toBe(second.signatureValue);
  });

  it("produces a P1363-length value for ECDSA", async () => {
    const provider = createMockSigningProvider({ keyType: "EC" });
    const cert = await provider.getSigningCertificate();
    const { signatureValue, algorithm } = await provider.sign({
      dataToBeSigned: new TextEncoder().encode("x"),
      hash: "SHA-384",
      expectCertificateDer: cert.certificateDer,
    });

    expect(algorithm).toBe("ES384");
    // r‖s for P-384 is 2 × 48 bytes.
    expect(Buffer.from(signatureValue, "base64")).toHaveLength(96);
  });

  it("refuses to sign when the certificate changed underneath it", async () => {
    const provider = createMockSigningProvider();
    await expect(
      provider.sign({
        dataToBeSigned: new TextEncoder().encode("x"),
        hash: "SHA-256",
        expectCertificateDer: "a-different-certificate",
      }),
    ).rejects.toMatchObject({ code: "card-changed" });
  });

  it("can be made to fail, so the UI's error paths are testable", async () => {
    const provider = createMockSigningProvider({ failWith: "pin-blocked" });
    const cert = await provider.getSigningCertificate();
    await expect(
      provider.sign({
        dataToBeSigned: new TextEncoder().encode("x"),
        hash: "SHA-256",
        expectCertificateDer: cert.certificateDer,
      }),
    ).rejects.toMatchObject({ code: "pin-blocked" });
  });
});
