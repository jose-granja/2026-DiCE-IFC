"use client";

/**
 * A container's signature, reduced to what a list row can show.
 *
 * Shared by the viewer (an `.ifczip` model) and the BCF manager (a signed
 * `.bcf`), because ADR 002 gives them the same container: the archive with
 * `META-INF/` added. One signing story, one summary, one set of words for it.
 *
 * The distinction that matters is three-way, not two:
 *
 *  - `undefined` — not a container, or a container with no signature in it.
 *    Normal, and gets no badge. Labelling every ordinary file "unsigned" trains
 *    people to ignore the row that matters.
 *  - `null` — a signed container whose check is still running.
 *  - a value — checked, valid or not.
 */

import { verifyContainer } from "./verify";

export type SignatureSummary = {
  /** The archive this came from, e.g. `model.ifczip`. */
  containerName: string;
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

/** `CN=…` out of an RFC 4514 subject, falling back to the whole string. */
export function commonName(subject: string): string {
  return /CN=([^,]+)/.exec(subject)?.[1]?.trim() || subject;
}
