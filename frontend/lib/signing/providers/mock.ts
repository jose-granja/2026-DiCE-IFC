/**
 * Deterministic signing provider for tests and UI development.
 *
 * It produces a syntactically well-formed signature that no verifier will
 * accept, which is the point: it exercises the XAdES builder, the manifest
 * logic and the container assembly without hardware, and it can never be
 * mistaken for a real signature because its certificate is self-evidently fake.
 *
 * Real cryptographic coverage — including the CC v1 RSA / CC v2 ECDSA split —
 * comes from the `softhsm` provider in CI, not from here.
 */

import {
  SigningError,
  type HashAlgorithm,
  type KeyType,
  type ReadinessReport,
  type SignRequest,
  type SignResult,
  type SignatureAlgorithm,
  type SigningCertificate,
  type SigningProvider,
} from "../provider";

export type MockProviderOptions = {
  /** `RSA` mimics a CC v1, `EC` a CC v2. */
  keyType?: KeyType;
  supportedAlgorithms?: SignatureAlgorithm[];
  /** Make `sign` fail, to exercise the error paths in the UI. */
  failWith?: ConstructorParameters<typeof SigningError>[0];
  /** Simulated latency, so loading states are visible while developing. */
  delayMs?: number;
};

const FAKE_SUBJECT =
  "CN=NOME EXEMPLO (Assinatura Digital Qualificada), SERIALNUMBER=BI000000000, C=PT";

export function createMockSigningProvider(
  options: MockProviderOptions = {},
): SigningProvider {
  const keyType = options.keyType ?? "EC";
  const supportedAlgorithms =
    options.supportedAlgorithms ??
    (keyType === "EC" ? ["ES384", "ES256"] : ["RS256", "RS384"]);

  const certificateDer = fakeCertificateDer(keyType);

  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();

  return {
    id: "mock",

    async getReadiness(): Promise<ReadinessReport> {
      return {
        providerId: "mock",
        ready: true,
        checks: [
          {
            id: "card",
            label: "Mock signing device (no real card)",
            status: "ok",
          },
        ],
      };
    },

    async getSigningCertificate(): Promise<SigningCertificate> {
      await pause();
      return {
        certificateDer,
        chainDer: [],
        subject: FAKE_SUBJECT,
        issuer: "CN=MOCK EC de Assinatura Digital Qualificada do Cartao de Cidadao, C=PT",
        serial: "00",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2031-01-01T00:00:00.000Z",
        keyType,
        supportedAlgorithms,
      };
    },

    async sign(request: SignRequest): Promise<SignResult> {
      await pause();

      if (options.failWith) {
        throw new SigningError(
          options.failWith,
          `Mock signing provider configured to fail with "${options.failWith}".`,
        );
      }

      if (request.expectCertificateDer !== certificateDer) {
        // The real providers must make this check too: a card swapped between
        // `getSigningCertificate` and `sign` would otherwise yield a signature
        // over a SignedInfo naming someone else's certificate.
        throw new SigningError(
          "card-changed",
          "The signing certificate changed between building the signature and signing it.",
        );
      }

      const algorithm = supportedAlgorithms[0];
      const digest = await crypto.subtle.digest(
        request.hash satisfies HashAlgorithm,
        request.dataToBeSigned as unknown as ArrayBuffer,
      );

      // A deterministic value derived from the digest: the same input always
      // produces the same "signature", so container-assembly tests can assert
      // on exact bytes.
      const signature = new Uint8Array(signatureLength(algorithm));
      const source = new Uint8Array(digest);
      for (let i = 0; i < signature.length; i += 1) {
        signature[i] = source[i % source.length] ^ (i & 0xff);
      }

      return {
        signatureValue: toBase64(signature),
        algorithm,
        certificateDer,
      };
    },
  };
}

/** P1363 `r‖s` for ECDSA, or a plausible modulus length for RSA. */
function signatureLength(algorithm: SignatureAlgorithm): number {
  switch (algorithm) {
    case "ES256":
      return 64;
    case "ES384":
      return 96;
    case "ES512":
      return 132;
    default:
      return 256; // 2048-bit RSA
  }
}

/**
 * Not a real certificate — a labelled byte blob. Anything that tries to parse
 * it will fail loudly, which is better than a fake that looks parseable.
 */
function fakeCertificateDer(keyType: KeyType): string {
  return toBase64(
    new TextEncoder().encode(
      `DICE-IFC-MOCK-CERTIFICATE:${keyType}:NOT-A-REAL-X509-CERTIFICATE`,
    ),
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
}
