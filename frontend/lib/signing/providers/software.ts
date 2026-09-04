/**
 * A signing provider backed by real WebCrypto keys.
 *
 * Not a mock. It generates a genuine key pair, mints a genuine self-signed
 * X.509 certificate around it, and produces genuine signatures — so a test can
 * build a XAdES signature, verify it, and have that mean something. The `mock`
 * provider cannot do that: its certificate is a fixture and its signature is a
 * constant, which exercises the plumbing and nothing else.
 *
 * **This is what covers the CC v1 / CC v2 split.** A CC v1 is RSA and a CC v2
 * (June 2024+) is ECDSA, and `negotiateAlgorithm` picks between them from the
 * certificate. Generating one provider of each kind runs both paths end to end.
 *
 * ADR 004 named SoftHSM2 for this. SoftHSM2 exercises PKCS#11 as well, which
 * matters for the native host, but it needs installing and configuring on every
 * machine and in CI. This covers everything above the device boundary — the
 * XAdES builder, the container, the verifier — with no installation at all.
 * SoftHSM2 remains the right tool for the layer below, and the real card for
 * the layer below that.
 *
 * It is registered only when `NEXT_PUBLIC_SIGNING_PROVIDER=software`, and it
 * says so in its readiness report, so it can never be mistaken for a card.
 */

import {
  base64,
  fromBase64,
} from "../canonical";
import {
  bitString,
  concat,
  encode,
  explicit,
  integer,
  name,
  nullValue,
  oid,
  readCertificate,
  sequence,
  utcTime,
} from "../der";
import {
  SigningError,
  hashForAlgorithm,
  type KeyType,
  type ReadinessReport,
  type SignRequest,
  type SignResult,
  type SignatureAlgorithm,
  type SigningCertificate,
  type SigningProvider,
} from "../provider";

export type SoftwareProviderOptions = {
  /** `RSA` mimics a CC v1, `EC` a CC v2. */
  keyType?: KeyType;
  subject?: Array<[string, string]>;
  /** Fixed validity, so a test certificate does not expire mid-suite. */
  notBefore?: Date;
  notAfter?: Date;
};

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";

export async function createSoftwareSigningProvider(
  options: SoftwareProviderOptions = {},
): Promise<SigningProvider> {
  const keyType = options.keyType ?? "RSA";
  const subject = options.subject ?? [
    ["CN", "SOFTWARE TEST KEY (NOT A CARD)"],
    ["C", "PT"],
  ];

  const keyPair = (await crypto.subtle.generateKey(
    keyType === "EC"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: Uint8Array.of(1, 0, 1),
          hash: "SHA-256",
        },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  );

  const certificateDer = await selfSign({
    spki,
    privateKey: keyPair.privateKey,
    keyType,
    subject,
    notBefore: options.notBefore ?? new Date("2020-01-01T00:00:00Z"),
    notAfter: options.notAfter ?? new Date("2040-01-01T00:00:00Z"),
  });

  const parsed = readCertificate(certificateDer);
  const supportedAlgorithms: SignatureAlgorithm[] =
    keyType === "EC" ? ["ES256"] : ["RS256"];

  const certificate: SigningCertificate = {
    certificateDer: base64(certificateDer),
    chainDer: [],
    subject: parsed.subject,
    issuer: parsed.issuer,
    serial: parsed.serial,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    keyType: parsed.keyType,
    supportedAlgorithms,
  };

  return {
    id: "software",

    async getReadiness(): Promise<ReadinessReport> {
      return {
        providerId: "software",
        ready: true,
        checks: [
          {
            id: "card",
            label: "Software test key — not a Cartão de Cidadão",
            status: "ok",
            remedy:
              "Signatures produced with this key are cryptographically valid but legally meaningless. Set NEXT_PUBLIC_SIGNING_PROVIDER=webeid to use a real card.",
          },
        ],
      };
    },

    async getSigningCertificate() {
      return certificate;
    },

    async sign(request: SignRequest): Promise<SignResult> {
      // The same guard the real device must apply: a card swapped between
      // preparing and signing would otherwise produce a signature over a
      // SignedInfo that names someone else's certificate.
      if (request.expectCertificateDer !== certificate.certificateDer) {
        throw new SigningError(
          "card-changed",
          "The signing certificate changed between preparing and signing.",
        );
      }

      const algorithm = supportedAlgorithms[0];
      if (hashForAlgorithm(algorithm) !== request.hash) {
        throw new SigningError(
          "unsupported-algorithm",
          `This key signs with ${algorithm}, but ${request.hash} was requested.`,
        );
      }

      const signature = new Uint8Array(
        await crypto.subtle.sign(
          keyType === "EC"
            ? { name: "ECDSA", hash: request.hash }
            : { name: "RSASSA-PKCS1-v1_5" },
          keyPair.privateKey,
          request.dataToBeSigned.buffer.slice(
            request.dataToBeSigned.byteOffset,
            request.dataToBeSigned.byteOffset + request.dataToBeSigned.byteLength,
          ) as ArrayBuffer,
        ),
      );

      // WebCrypto already returns ECDSA as raw P1363 `r‖s`, which is what
      // XMLDSig wants — the same form the card returns through PKCS#11.
      return {
        signatureValue: base64(signature),
        algorithm,
        certificateDer: certificate.certificateDer,
      };
    },
  };
}

/**
 * Mint a self-signed certificate around a public key.
 *
 * Minimal but structurally real: version 3, a serial, matching issuer and
 * subject, a validity window and the SPKI. No extensions — nothing in the
 * verification path reads them, and adding them would be encoding for its own
 * sake.
 */
async function selfSign(input: {
  spki: Uint8Array;
  privateKey: CryptoKey;
  keyType: KeyType;
  subject: Array<[string, string]>;
  notBefore: Date;
  notAfter: Date;
}): Promise<Uint8Array> {
  const algorithmId =
    input.keyType === "EC"
      ? sequence(oid(OID_ECDSA_SHA256))
      : sequence(oid(OID_SHA256_RSA), nullValue());

  const subjectName = name(input.subject);

  const tbs = sequence(
    explicit(0, integer(2)),
    integer(crypto.getRandomValues(new Uint8Array(8))),
    algorithmId,
    subjectName,
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    subjectName,
    input.spki,
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      input.keyType === "EC"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "RSASSA-PKCS1-v1_5" },
      input.privateKey,
      tbs.buffer.slice(tbs.byteOffset, tbs.byteOffset + tbs.byteLength) as ArrayBuffer,
    ),
  );

  // The certificate's own signature is never checked by anything here — it is
  // self-signed, so it proves nothing — but it has to be present and
  // well-formed for the structure to parse.
  const encoded =
    input.keyType === "EC" ? derFromP1363(signature) : signature;

  return sequence(tbs, algorithmId, bitString(encoded));
}

/**
 * P1363 `r‖s` → the DER `SEQUENCE { r INTEGER, s INTEGER }` X.509 wants.
 *
 * Only for the certificate's own signature. XAdES signature values stay in
 * P1363, which is what XMLDSig specifies — converting those would break them.
 */
function derFromP1363(signature: Uint8Array): Uint8Array {
  const half = signature.length / 2;
  return sequence(
    integer(trimLeadingZeros(signature.subarray(0, half))),
    integer(trimLeadingZeros(signature.subarray(half))),
  );
}

function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

export { fromBase64, encode, concat };
