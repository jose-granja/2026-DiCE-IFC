"use client";

/**
 * A file's signature, reduced to what a list row can show.
 *
 * Shared by the viewer (an `.ifczip` model) and the BCF manager (a signed
 * `.bcf`), because ADR 002 gives them the same container: the archive with
 * `META-INF/` added. One signing story, one summary, one set of words for it.
 *
 * The distinction that matters is three-way, not two:
 *
 *  - `undefined` — an ordinary model or container with no signature in it.
 *    Normal, and gets no badge. Labelling every ordinary file "unsigned" trains
 *    people to ignore the row that matters.
 *  - `null` — a signed container whose check is still running.
 *  - a value — checked, valid or not.
 */

import { verifyContainer } from "./verify";
import { inspectEmbeddedSignatures } from "./embedded";
import { EmbeddedIfcError, type EmbeddedIfcErrorCode } from "./embedded-format";

export type SignatureSummary = {
  /** The signed model or archive this came from. */
  containerName: string;
  format?: "embedded";
  embeddedProblem?: EmbeddedIfcErrorCode | "unknown";
  /** False when any signature failed, or a reference did not match. */
  valid: boolean;
  signers: Array<{
    subject: string;
    issuer: string;
    signingTime?: string;
    algorithm: string;
    valid: boolean;
    /** Always `not-checked` until the trust proxy lands — see verify.ts. */
    trust: "not-checked" | "trusted" | "untrusted";
  }>;
  problems: string[];
};

/**
 * Verify a container, if it carries a signature.
 *
 * Returns `undefined` when there is nothing to check — an unsigned archive is
 * not a failure. Never throws: a signature that cannot be checked is reported
 * as a problem on the summary, because the alternative is an exception where
 * the caller wanted a badge.
 */
export async function summariseSignature(
  bytes: Uint8Array,
  containerName: string,
): Promise<SignatureSummary | undefined> {
  try {
    const result = await verifyContainer(bytes);
    if (result.signatures.length === 0) return undefined;

    return {
      containerName,
      valid: result.signatures.every((entry) => entry.valid),
      problems: result.problems,
      signers: result.signatures.map((entry) => ({
        subject: entry.subject,
        issuer: entry.issuer,
        signingTime: entry.signingTime,
        algorithm: entry.algorithm,
        valid: entry.valid,
        trust: entry.trust,
      })),
    };
  } catch (error) {
    return {
      containerName,
      valid: false,
      signers: [],
      problems: [
        error instanceof Error
          ? `The signature could not be checked: ${error.message}`
          : "The signature could not be checked.",
      ],
    };
  }
}

/** Inspect raw IFC signatures off the UI thread. Unsupported unsigned models
 * remain ordinary models; a claimed signature that fails gets an invalid badge. */
export async function summariseEmbeddedSignature(file: File): Promise<SignatureSummary | undefined> {
  if (!/\.ifc$/i.test(file.name)) return undefined;
  try {
    const result = await inspectEmbeddedSignatures(file);
    if (!result) return undefined;
    const valid = result.signatures.length > 0 && result.signatures.every((entry) => entry.valid);
    return {
      containerName: file.name, format: "embedded", valid,
      problems: [], embeddedProblem: valid ? undefined : "invalid-signature",
      signers: result.signatures.map((entry) => ({
        subject: entry.subject ?? "", issuer: entry.issuer ?? "", signingTime: entry.signingTime,
        algorithm: entry.algorithm ?? "", valid: entry.valid, trust: "not-checked",
      })),
    };
  } catch (error) {
    return {
      containerName: file.name, format: "embedded", valid: false, signers: [], problems: [],
      embeddedProblem: error instanceof EmbeddedIfcError ? error.code : "unknown",
    };
  }
}

/** `CN=…` out of an RFC 4514 subject, falling back to the whole string. */
export function commonName(subject: string): string {
  return /CN=([^,]+)/.exec(subject)?.[1]?.trim() || subject;
}
