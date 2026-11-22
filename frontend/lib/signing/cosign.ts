/**
 * Adding a signature to a file someone has already signed: author, then
 * reviewer, then coordinator, on one file.
 *
 * Two formats, two meanings, and the page says which:
 *
 * - **IFCZIP (ASiC-E, ADR 002).** The co-signature is a new
 *   `META-INF/signaturesNNN.xml` over the same payload. Signatures are
 *   *parallel*: each covers the model alone, so removing one leaves the others
 *   valid.
 * - **Inside the IFC (ADR 011).** The co-signature is a new comment block after
 *   the last one, covering the normalized file up to it — the model **and the
 *   signatures before it**. Signatures are *sequential*: the reviewer signs
 *   what the author signed, signature included.
 *
 * Whatever the format, everything below runs **before the card is asked for a
 * signature**, so a file that must not be co-signed never costs a PIN entry:
 *
 * - every existing signature has to verify. Adding your name to a file that
 *   was altered after it was signed would vouch for the alteration;
 * - (IFCZIP) every payload file has to be covered by an existing signature. A
 *   file slipped into a signed container afterwards would otherwise be signed
 *   by the next person without anyone having looked at it;
 * - the card's holder must not already be a signer — a second signature from
 *   the same certificate adds nothing and reads as two approvals.
 *
 * And after: the result is verified as a whole — every signature, the new one
 * included — before it is offered for download.
 */

import { unzipSync } from "fflate";

import { addSignature, mimeTypeFor, payloadEntries } from "./asice";
import { fromBase64 } from "./canonical";
import { readCertificate } from "./der";
import type { SigningProvider } from "./provider";
import { signEntries, type FileToSign, type SignedOutput, type SignOptions } from "./sign";
import { verifyContainer } from "./verify";

export type CosignErrorCode =
  /** The file carries no signature to join. */
  | "not-signed"
  /** An existing signature does not verify: the file changed after it was signed. */
  | "existing-invalid"
  /** A file in the container is covered by no existing signature. */
  | "uncovered-payload"
  /** The card's certificate already signed this file. */
  | "already-signer"
  /** The embedded format carries at most this many signatures. */
  | "too-many-signatures"
  /** The co-signed file did not verify as a whole. Nothing is offered. */
  | "result-invalid";

export class CosignError extends Error {
  constructor(readonly code: CosignErrorCode) {
    super(code);
    this.name = "CosignError";
  }
}

/** An existing signature, as both formats' verifiers report it. */
export type ExistingSigner = {
  subject?: string;
  issuer?: string;
  serial?: string;
  valid: boolean;
};

/** ADR 011: a verifier reads at most 16 embedded signature blocks. */
export const MAX_EMBEDDED_SIGNATURES = 16;

/** Refuse what a co-signature must not join. Before the card is touched. */
export function checkExistingSignatures(signers: ExistingSigner[], limit?: number): void {
  if (signers.length === 0) throw new CosignError("not-signed");
  if (signers.some((signer) => !signer.valid)) throw new CosignError("existing-invalid");
  if (limit !== undefined && signers.length >= limit) throw new CosignError("too-many-signatures");
}

/**
 * Refuse a second signature from the same certificate. Issuer and serial
 * identify a certificate; both sides are read by the same parser the verifiers
 * use, so their spelling agrees. A renewed card is a new certificate, and may
 * sign.
 */
export function checkNotAlreadySigner(signers: ExistingSigner[], certificateDer: string): void {
  const card = readCertificate(fromBase64(certificateDer));
  if (signers.some((signer) => signer.issuer === card.issuer && signer.serial === card.serial)) {
    throw new CosignError("already-signer");
  }
}

export type CosignOptions = Pick<SignOptions, "onProgress" | "timestamper" | "now" | "idSuffix" | "details"> & {
  current?: number;
  total?: number;
};

/**
 * Add the card holder's signature to a signed IFCZIP (or any ASiC-E
 * container), as its next `signaturesNNN.xml`, over the same payload. The
 * output keeps the input's name: it is the same document with one more
 * signature.
 */
export async function cosignContainer(
  file: FileToSign,
  provider: SigningProvider,
  options: CosignOptions = {},
): Promise<SignedOutput> {
  const current = options.current ?? 1;
  const total = options.total ?? 1;
  options.onProgress?.({ phase: "preparing", current, total, fileName: file.name });

  const before = await verifyContainer(file.bytes);
  checkExistingSignatures(before.signatures);

  // The payload a co-signature covers is the container's; every part of it
  // must already be vouched for by someone. Directory entries carry no bytes.
  const covered = new Set(
    before.signatures.flatMap((signature) =>
      signature.references.filter((reference) => !reference.uri.startsWith("#")).map((reference) => reference.uri),
    ),
  );
  if (before.payload.some((path) => !path.endsWith("/") && !covered.has(path))) {
    throw new CosignError("uncovered-payload");
  }

  options.onProgress?.({ phase: "certificate", current, total, fileName: file.name });
  const certificate = await provider.getSigningCertificate();
  checkNotAlreadySigner(before.signatures, certificate.certificateDer);

  // The bytes as stored, never re-serialised: the existing signatures were
  // taken over exactly these.
  const entries = payloadEntries(unzipSync(file.bytes)).map((entry) => ({
    ...entry,
    mimeType: mimeTypeFor(entry.name),
  }));
  const signed = await signEntries(entries, certificate, provider, options, { current, total, fileName: file.name });
  const bytes = addSignature(file.bytes, signed.signatureXml);

  const after = await verifyContainer(bytes);
  if (
    after.signatures.length !== before.signatures.length + 1 ||
    !after.signatures.every((signature) => signature.valid)
  ) {
    throw new CosignError("result-invalid");
  }

  options.onProgress?.({ phase: "done", current, total });
  return { name: file.name, bytes, covers: before.payload, timestamp: signed.timestamp };
}
