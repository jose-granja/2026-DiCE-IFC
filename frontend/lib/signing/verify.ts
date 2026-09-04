/**
 * Offline verification of a signed container.
 *
 * Re-hash the payload, re-canonicalise `SignedInfo`, check the signature
 * against the certificate the container carries, and report what was found.
 *
 * ## What this proves, and what it does not
 *
 * A green result here means: **the bytes in this container are exactly the
 * bytes that were signed, and whoever signed them held the private key for the
 * enclosed certificate.** That is integrity and authenticity relative to that
 * certificate.
 *
 * It does **not** mean the certificate is trustworthy. Checking that it chains
 * to a Portuguese qualified CA, that it was not revoked, and that the signature
 * predates its expiry all require the trusted list, OCSP and a timestamp — none
 * of which a browser can fetch (no CORS), which is what the `trust/` proxy is
 * for. Until that exists, `VerificationResult.trust` says `"not-checked"` and
 * the UI must not present a valid signature as a trusted one. Overstating this
 * would be the single most damaging thing this module could do.
 *
 * `DOMParser` reads the signature, and `c14n.ts` canonicalises the fragments
 * before hashing them. Hashing the stored bytes instead only works for
 * signatures this application wrote: another tool's `SignedInfo` inherits its
 * namespace declaration and writes empty elements as `<x/>`, so the bytes on
 * disk are not the bytes that were signed. That shortcut reported real Cartão
 * de Cidadão signatures as broken.
 */

import { unzipSync } from "fflate";

import { digestBase64, fromBase64 } from "./canonical";
import { canonicalize } from "./c14n";
import { readCertificate } from "./der";
import { listSignatureFiles } from "./asice";
import type { HashAlgorithm } from "./provider";

const C14N_EXCLUSIVE = "http://www.w3.org/2001/10/xml-exc-c14n#";

export type ReferenceCheck = {
  uri: string;
  /** False when the file a Reference names is not in the container. */
  present: boolean;
  /** True when the stored bytes hash to the digest in the signature. */
  digestMatches: boolean;
};

export type TrustStatus = "not-checked" | "trusted" | "untrusted";

export type SignatureVerification = {
  /** `META-INF/signatures001.xml`. */
  file: string;
  /** Every check passed: signature valid and every reference intact. */
  valid: boolean;
  /** The maths: does the signature verify over the canonical SignedInfo? */
  signatureValid: boolean;
  references: ReferenceCheck[];
  signingTime?: string;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  algorithm: string;
  /**
   * Always `not-checked` until the `trust/` proxy lands. See the note above:
   * a valid signature is not a trusted one.
   */
  trust: TrustStatus;
  /** Anything that stopped a check from running. */
  problems: string[];
};

export type ContainerVerification = {
  signatures: SignatureVerification[];
  /** Payload entries, for the UI to list what is actually covered. */
  payload: string[];
  problems: string[];
};

export async function verifyContainer(
  bytes: Uint8Array,
): Promise<ContainerVerification> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    return {
      signatures: [],
      payload: [],
      problems: [
        `That file is not a readable ZIP archive: ${error instanceof Error ? error.message : "unknown error"}`,
      ],
    };
  }

  const payload = Object.keys(entries).filter(
    (path) => path !== "mimetype" && !path.startsWith("META-INF/"),
  );

  const files = listSignatureFiles(entries);
  if (files.length === 0) {
    return {
      signatures: [],
      payload,
      problems: ["This container carries no signature."],
    };
  }

  const signatures: SignatureVerification[] = [];
  for (const file of files) {
    signatures.push(
      await verifySignatureFile(file, new TextDecoder().decode(entries[file]), entries),
    );
  }

  return { signatures, payload, problems: [] };
}

async function verifySignatureFile(
  file: string,
  xml: string,
  entries: Record<string, Uint8Array>,
): Promise<SignatureVerification> {
  const problems: string[] = [];
  const document_ = new DOMParser().parseFromString(xml, "application/xml");

  if (document_.querySelector("parsererror")) {
    return failed(file, "The signature file is not well-formed XML.");
  }

  const certificateBase64 = text(document_, "X509Certificate");
  if (!certificateBase64) return failed(file, "The signature carries no certificate.");

  const certificateDer = fromBase64(certificateBase64);
  const info = readCertificate(certificateDer);

  const signatureValue = text(document_, "SignatureValue");
  if (!signatureValue) return failed(file, "The signature carries no signature value.");

  const signatureMethod =
    find(document_, "SignatureMethod")?.getAttribute("Algorithm") ?? "";
  const algorithm = algorithmFor(signatureMethod, info.keyType);
  if (!algorithm) {
    return failed(
      file,
      `Unsupported signature algorithm: ${signatureMethod || "(none)"}`,
    );
  }

  // Canonicalised, not taken from the file. `CanonicalizationMethod` names the
  // transform the signer applied before hashing, and a verifier has to apply
  // the same one.
  const signedInfoElement = find(document_, "SignedInfo");
  if (!signedInfoElement) return failed(file, "The signature has no SignedInfo.");

  const method =
    childElement(signedInfoElement, "CanonicalizationMethod")?.getAttribute(
      "Algorithm",
    ) ?? "";
  if (method && !method.startsWith(C14N_EXCLUSIVE)) {
    problems.push(
      `This signature uses ${method}, which this application cannot reproduce; only exclusive canonicalisation is implemented.`,
    );
  }
  const signedInfoXml = canonicalize(signedInfoElement);

  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(info.spki),
      algorithm.importParams,
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      algorithm.verifyParams,
      key,
      toArrayBuffer(fromBase64(signatureValue)),
      toArrayBuffer(new TextEncoder().encode(signedInfoXml)),
    );
  } catch (error) {
    problems.push(
      `The signature could not be checked: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const references = await checkReferences(document_, entries, problems);

  return {
    file,
    signatureValid,
    valid:
      signatureValid &&
      references.length > 0 &&
      references.every((reference) => reference.present && reference.digestMatches),
    references,
    signingTime: text(document_, "SigningTime"),
    subject: info.subject,
    issuer: info.issuer,
    serial: info.serial,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
    algorithm: algorithm.label,
    trust: "not-checked",
    problems,
  };
}

async function checkReferences(
  document_: Document,
  entries: Record<string, Uint8Array>,
  problems: string[],
): Promise<ReferenceCheck[]> {
  const checks: ReferenceCheck[] = [];

  for (const reference of Array.from(document_.getElementsByTagName("*")).filter(
    (node) => node.localName === "Reference",
  )) {
    const uri = reference.getAttribute("URI") ?? "";
    const expected = childText(reference, "DigestValue");
    const method = childElement(reference, "DigestMethod")?.getAttribute("Algorithm");
    const hash = hashFor(method);

    if (!expected || !hash) {
      problems.push(`A reference to ${uri || "(no URI)"} is incomplete.`);
      continue;
    }

    if (uri.startsWith("#")) {
      // A same-document reference — in practice SignedProperties. Resolved by
      // Id rather than by element name, because that is what the URI says and
      // because a signature may carry more than one.
      const target = elementById(document_, uri.slice(1));
      const actual = target
        ? await digestBase64(hash, new TextEncoder().encode(canonicalize(target)))
        : "";
      checks.push({
        uri,
        present: Boolean(target),
        digestMatches: Boolean(target) && actual === expected,
      });
      continue;
    }

    const name = decodeURI(uri);
    const bytes = entries[name];
    checks.push({
      uri: name,
      present: Boolean(bytes),
      digestMatches: Boolean(bytes) && (await digestBase64(hash, bytes)) === expected,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An element by `Id`.
 *
 * `getElementById` does not work here: it only knows attributes declared as ID
 * in a DTD, and a signature has none. XMLDSig resolves a bare `#name` fragment
 * against the `Id` attribute, so that is what this matches.
 */
function elementById(document_: Document, id: string): Element | undefined {
  return Array.from(document_.getElementsByTagName("*")).find(
    (node) => node.getAttribute("Id") === id,
  );
}

function find(document_: Document, localName: string): Element | undefined {
  return Array.from(document_.getElementsByTagName("*")).find(
    (node) => node.localName === localName,
  );
}

function text(document_: Document, localName: string): string | undefined {
  const value = find(document_, localName)?.textContent?.trim();
  return value || undefined;
}

function childElement(parent: Element, localName: string): Element | undefined {
  return Array.from(parent.getElementsByTagName("*")).find(
    (node) => node.localName === localName,
  );
}

function childText(parent: Element, localName: string): string | undefined {
  return childElement(parent, localName)?.textContent?.trim() || undefined;
}

function hashFor(uri: string | null | undefined): HashAlgorithm | null {
  if (!uri) return null;
  if (uri.endsWith("sha256")) return "SHA-256";
  if (uri.endsWith("sha384")) return "SHA-384";
  if (uri.endsWith("sha512")) return "SHA-512";
  return null;
}

type AlgorithmChoice = {
  label: string;
  importParams: RsaHashedImportParams | EcKeyImportParams;
  verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
};

function algorithmFor(uri: string, keyType: "RSA" | "EC"): AlgorithmChoice | null {
  const hash = uri.includes("sha512")
    ? "SHA-512"
    : uri.includes("sha384")
      ? "SHA-384"
      : uri.includes("sha256")
        ? "SHA-256"
        : null;
  if (!hash) return null;

  if (uri.includes("ecdsa") || keyType === "EC") {
    return {
      label: `ECDSA-${hash}`,
      importParams: { name: "ECDSA", namedCurve: curveFor(hash) },
      verifyParams: { name: "ECDSA", hash },
    };
  }

  if (uri.includes("rsa-pss")) {
    return {
      label: `RSA-PSS-${hash}`,
      importParams: { name: "RSA-PSS", hash },
      verifyParams: { name: "RSA-PSS", saltLength: saltLengthFor(hash) },
    };
  }

  return {
    label: `RSA-${hash}`,
    importParams: { name: "RSASSA-PKCS1-v1_5", hash },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  };
}

/**
 * XMLDSig names ECDSA by hash, not by curve, so the curve has to be inferred.
 * The usual pairing holds for the Cartão de Cidadão, whose v2 key is P-256.
 */
function curveFor(hash: string): string {
  if (hash === "SHA-512") return "P-521";
  if (hash === "SHA-384") return "P-384";
  return "P-256";
}

function saltLengthFor(hash: string): number {
  if (hash === "SHA-512") return 64;
  if (hash === "SHA-384") return 48;
  return 32;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function failed(file: string, problem: string): SignatureVerification {
  return {
    file,
    valid: false,
    signatureValid: false,
    references: [],
    subject: "",
    issuer: "",
    serial: "",
    notBefore: "",
    notAfter: "",
    algorithm: "",
    trust: "not-checked",
    problems: [problem],
  };
}
