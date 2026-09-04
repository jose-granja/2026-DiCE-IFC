/**
 * The signing device, behind one interface.
 *
 * Three implementations (see `docs/adr/004-card-signing-companion.md`):
 *
 *   `companion` the real Cartão de Cidadão, through the DiCE-IFC signing
 *              companion in `companion/` — a local service driving pteid over
 *              PKCS#11. The default. See ADR 007.
 *   `webeid`   the same card through the Web eID extension. Kept because
 *              upstreaming Portuguese support would make it the better answer
 *              (ADR 004), but no such build exists today, so it cannot sign.
 *   `softhsm`  SoftHSM2 with one RSA and one ECDSA test key, driving the same
 *              native host — the only way CI can cover the CC v1 / CC v2
 *              algorithm split
 *   `software` real WebCrypto keys and a real self-signed certificate — no
 *              hardware, but genuine signatures, so the XAdES builder and the
 *              verifier can be tested end to end for both RSA and ECDSA
 *   `mock`     deterministic fixtures, for UI work
 *
 * The XAdES builder, the manifest logic and the container assembly are written
 * against this interface, so all of them are testable without hardware. Only
 * the final card round-trip needs a person and a reader.
 *
 * Two hard rules, both from ADR 004:
 *
 *  1. **There is no PIN parameter anywhere in this file, and there must never
 *     be one.** The pteid PKCS#11 module raises its own PIN dialog; we never
 *     see, transport, cache or store it.
 *  2. **The algorithm is negotiated, never assumed.** CC v1 is RSA, CC v2
 *     (June 2024+) is ECDSA. Read it from the certificate and from what the
 *     device returns.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** JWS algorithm identifiers, as Web eID reports them. */
export type SignatureAlgorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512";

export type HashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";

export type KeyType = "RSA" | "EC";

export type SigningCertificate = {
  /** DER-encoded X.509, base64. This is what goes into `ds:X509Certificate`. */
  certificateDer: string;
  /** Issuer chain, leaf-first, base64 DER. May be empty if the device has none. */
  chainDer: string[];
  /** Parsed for display and for the XAdES `SigningCertificateV2` property. */
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  /**
   * Derived from the certificate's SubjectPublicKeyInfo. `RSA` means a CC v1,
   * `EC` a CC v2 — but treat that as a hint for the UI, not a branch in the
   * signing path.
   */
  keyType: KeyType;
  /** Algorithms this device will actually sign with, best first. */
  supportedAlgorithms: SignatureAlgorithm[];
};

export type SignRequest = {
  /**
   * The bytes to be signed — for XAdES, the canonicalised `SignedInfo`, never
   * the document. Raw bytes, not base64: hashing happens here so no caller can
   * accidentally sign a base64 rendering of the wrong thing.
   */
  dataToBeSigned: Uint8Array;
  /** Which digest to compute over `dataToBeSigned`. */
  hash: HashAlgorithm;
  /**
   * Certificate the caller built `dataToBeSigned` against. The device must
   * refuse if the inserted card no longer matches — otherwise a swapped card
   * produces a signature over a `SignedInfo` that references someone else's
   * certificate.
   */
  expectCertificateDer: string;
};

export type SignResult = {
  /**
   * The signature value, base64.
   *
   * For ECDSA this is raw P1363 `r‖s`, which is what XMLDSig/XAdES wants
   * directly. CMS/CAdES would need DER re-encoding — we produce XAdES, so it
   * does not, but do not pass this to a CMS library without converting.
   */
  signatureValue: string;
  algorithm: SignatureAlgorithm;
  /** Echo of the certificate actually used, for the caller to re-check. */
  certificateDer: string;
};

/** Everything `/sign/setup` needs to render its per-OS checklist. */
export type ReadinessReport = {
  providerId: SigningProviderId;
  ready: boolean;
  checks: ReadinessCheck[];
};

export type ReadinessCheck = {
  id: "extension" | "native-host" | "middleware" | "reader" | "card";
  label: string;
  status: "ok" | "missing" | "unknown";
  /** What the user should do about it, when the status is not `ok`. */
  remedy?: string;
  /** Where to go and get it. */
  href?: string;
};

export type SigningProviderId =
  | "companion"
  | "webeid"
  | "softhsm"
  | "software"
  | "mock";

export interface SigningProvider {
  readonly id: SigningProviderId;

  /**
   * Is this provider usable right now? Never throws — a missing extension is
   * the normal case on a fresh machine, not an exception.
   */
  getReadiness(): Promise<ReadinessReport>;

  /**
   * Ask the device for the CITIZEN SIGNATURE certificate.
   *
   * Not the authentication certificate: only the nonRepudiation key, behind the
   * PIN de Assinatura, may be used for document signing. A provider that cannot
   * distinguish them must fail rather than guess.
   */
  getSigningCertificate(): Promise<SigningCertificate>;

  /** Sign `dataToBeSigned`. The device raises its own PIN dialog. */
  sign(request: SignRequest): Promise<SignResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SigningErrorCode =
  /** Extension, native host, middleware, reader or card is missing. */
  | "not-ready"
  /** The user dismissed the PIN dialog or the browser prompt. */
  | "cancelled"
  /** Wrong PIN — the device says so; we never see the PIN itself. */
  | "pin-incorrect"
  /** Too many wrong attempts; the signature PIN is blocked. */
  | "pin-blocked"
  /** The card was removed mid-operation, or a different card is present. */
  | "card-changed"
  /** The device returned an algorithm we cannot build a XAdES signature with. */
  | "unsupported-algorithm"
  | "unknown";

export class SigningError extends Error {
  constructor(
    readonly code: SigningErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SigningError";
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const providers = new Map<SigningProviderId, () => Promise<SigningProvider>>();

/**
 * Registered lazily so a test run never loads the Web eID library, and a
 * production bundle never ships the SoftHSM or mock implementations.
 */
export function registerSigningProvider(
  id: SigningProviderId,
  load: () => Promise<SigningProvider>,
) {
  providers.set(id, load);
}

export function defaultSigningProviderId(): SigningProviderId {
  const configured = process.env.NEXT_PUBLIC_SIGNING_PROVIDER;
  if (
    configured === "softhsm" ||
    configured === "software" ||
    configured === "mock" ||
    configured === "webeid"
  ) {
    return configured;
  }
  return "companion";
}

export async function getSigningProvider(
  id: SigningProviderId = defaultSigningProviderId(),
): Promise<SigningProvider> {
  const load = providers.get(id);
  if (!load) {
    throw new SigningError(
      "not-ready",
      `No signing provider registered for "${id}".`,
    );
  }
  return load();
}

// ---------------------------------------------------------------------------
// Algorithm negotiation
// ---------------------------------------------------------------------------

/**
 * Pick the algorithm to sign with, given what the device offers.
 *
 * Both CC generations are covered without branching on card version: an RSA
 * card offers `RS*`/`PS*`, an ECDSA card offers `ES*`, and we take the
 * strongest each supports. If the device offers nothing we recognise, that is
 * an error — signing with an unknown algorithm would produce a container no
 * verifier could check.
 */
export function negotiateAlgorithm(
  certificate: SigningCertificate,
): { algorithm: SignatureAlgorithm; hash: HashAlgorithm } {
  const preference: SignatureAlgorithm[] =
    certificate.keyType === "EC"
      ? ["ES512", "ES384", "ES256"]
      : ["PS512", "PS384", "PS256", "RS512", "RS384", "RS256"];

  const chosen = preference.find((a) =>
    certificate.supportedAlgorithms.includes(a),
  );

  if (!chosen) {
    throw new SigningError(
      "unsupported-algorithm",
      `This card offers only ${certificate.supportedAlgorithms.join(", ") || "no"} ` +
        `signature algorithms, none of which this application can build a XAdES signature with.`,
    );
  }

  return { algorithm: chosen, hash: hashForAlgorithm(chosen) };
}

export function hashForAlgorithm(algorithm: SignatureAlgorithm): HashAlgorithm {
  if (algorithm.endsWith("512")) return "SHA-512";
  if (algorithm.endsWith("384")) return "SHA-384";
  return "SHA-256";
}

/** The XMLDSig algorithm URI for a JWS algorithm identifier. */
export function xmldsigAlgorithmUri(algorithm: SignatureAlgorithm): string {
  switch (algorithm) {
    case "RS256":
      return "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    case "RS384":
      return "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384";
    case "RS512":
      return "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
    case "PS256":
    case "PS384":
    case "PS512":
      return "http://www.w3.org/2007/05/xmldsig-more#rsa-pss";
    case "ES256":
      return "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";
    case "ES384":
      return "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384";
    case "ES512":
      return "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512";
  }
}

export function xmldsigDigestUri(hash: HashAlgorithm): string {
  switch (hash) {
    case "SHA-256":
      return "http://www.w3.org/2001/04/xmlenc#sha256";
    case "SHA-384":
      return "http://www.w3.org/2001/04/xmldsig-more#sha384";
    case "SHA-512":
      return "http://www.w3.org/2001/04/xmlenc#sha512";
  }
}
