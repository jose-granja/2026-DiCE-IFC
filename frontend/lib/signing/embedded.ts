"use client";

import * as Comlink from "comlink";
import type { EmbeddedSigningWorkerApi } from "../workers/embedded-signing.worker";
import { prepareCms } from "./cms";
import { checkExistingSignatures, checkNotAlreadySigner, CosignError, MAX_EMBEDDED_SIGNATURES } from "./cosign";
import type { SignatureDetails, StatedDetails } from "./details";
import { EmbeddedIfcError, type EmbeddedIfcErrorCode } from "./embedded-format";
import { fromBase64 } from "./canonical";
import { SigningError, type SigningProvider } from "./provider";
import { timestampFailure, type SignedOutput, type SignOptions } from "./sign";
import type { TimestampVerification } from "./verify";
export { EmbeddedIfcError } from "./embedded-format";

export type EmbeddedPhase = "reading" | "certificate" | "signing" | "timestamping" | "verifying";
export type EmbeddedVerification = { signatures: Array<{
  valid: boolean; subject?: string; issuer?: string; serial?: string; signingTime?: string; algorithm?: string;
  details?: StatedDetails;
  timestamp?: TimestampVerification;
}> };

function value<T>(reply: { value: T } | { error: EmbeddedIfcErrorCode }): T {
  if ("error" in reply) throw new EmbeddedIfcError(reply.error);
  return reply.value;
}
function openWorker(file: File) {
  if (!file.name.toLowerCase().endsWith(".ifc")) throw new EmbeddedIfcError("unsupported-format");
  const worker = new Worker(new URL("../workers/embedded-signing.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<EmbeddedSigningWorkerApi>(worker);
  return { worker, api };
}

export type EmbeddedSignOptions = {
  onProgress?: (phase: EmbeddedPhase) => void;
  /** Place and reason, as CAdES signed attributes. Professional attributes are XAdES-only for now. */
  details?: Omit<SignatureDetails, "professionalAttributes">;
  /**
   * Stamp the signature (CAdES-T): given SHA-256 of its signature value, a
   * token. A stamp that cannot be had is reported, never thrown.
   */
  timestamper?: SignOptions["timestamper"];
};

/** Sign an unsigned IFC: the signature is appended inside it (ADR 011). */
export function signEmbeddedIfc(file: File, provider: SigningProvider, options: EmbeddedSignOptions = {}) {
  return signEmbedded(file, provider, options, false);
}

/**
 * Add a signature to an IFC that already carries some (`cosign.ts`). It covers
 * the model and every signature before it. The output keeps the input's name.
 */
export function cosignEmbeddedIfc(file: File, provider: SigningProvider, options: EmbeddedSignOptions = {}) {
  return signEmbedded(file, provider, options, true);
}

async function signEmbedded(file: File, provider: SigningProvider, options: EmbeddedSignOptions, cosign: boolean) {
  const { worker, api } = openWorker(file);
  try {
    options.onProgress?.("reading");
    // Read and validate before asking for a card or triggering a PIN dialog.
    const { contentDigest, signatures } = value(await api.prepare(file, cosign));
    if (cosign) checkExistingSignatures(signatures, MAX_EMBEDDED_SIGNATURES);
    options.onProgress?.("certificate");
    const readiness = await provider.getReadiness();
    if (!readiness.ready) throw new SigningError("not-ready", "The card companion is not ready.");
    const certificate = await provider.getSigningCertificate();
    if (cosign) checkNotAlreadySigner(signatures, certificate.certificateDer);
    const at = new Date();
    const prepared = await prepareCms(contentDigest, certificate, at, options.details);
    options.onProgress?.("signing");
    // Only digest-bearing CMS metadata goes to localhost. The IFC stays in
    // the worker. The middleware owns the PIN dialog, exactly as for IFCZIP.
    const result = await provider.sign({ dataToBeSigned: prepared.dataToBeSigned,
      hash: prepared.hash, expectCertificateDer: certificate.certificateDer });
    let timestamp: SignedOutput["timestamp"];
    let timestampToken: Uint8Array | undefined;
    if (options.timestamper) {
      options.onProgress?.("timestamping");
      try {
        const stamped = await options.timestamper(await prepared.timestampDigest(result));
        timestampToken = fromBase64(stamped.token);
        timestamp = { status: "added", time: stamped.time, tsa: stamped.tsa };
      } catch (error) {
        // A card-changed or algorithm error from `timestampDigest` is the
        // signature's problem, not the stamp's: `complete` below throws it.
        timestamp = timestampFailure(error);
      }
    }
    options.onProgress?.("verifying");
    let bytes: Uint8Array;
    try { bytes = value(await api.finish(prepared.complete(result, { timestampToken }))); }
    catch (error) {
      // The chain did not verify as a whole after co-signing: nothing is offered.
      if (cosign && error instanceof EmbeddedIfcError && error.code === "invalid-signature") throw new CosignError("result-invalid");
      throw error;
    }
    const name = cosign ? file.name : file.name.replace(/\.ifc$/i, "-signed.ifc");
    return { bytes, name, certificate, signingTime: at.toISOString(), ...(timestamp ? { timestamp } : {}) };
  } finally {
    api[Comlink.releaseProxy]();
    worker.terminate();
  }
}

export async function verifyEmbeddedIfc(file: File): Promise<EmbeddedVerification> {
  const { worker, api } = openWorker(file);
  try { return value(await api.verify(file)); }
  finally { api[Comlink.releaseProxy](); worker.terminate(); }
}

/** Viewer discovery: unsigned models return undefined without strict profile
 * validation. A claimed but malformed signature still rejects for its badge. */
export async function inspectEmbeddedSignatures(file: File): Promise<EmbeddedVerification | undefined> {
  const { worker, api } = openWorker(file);
  try { return value(await api.inspect(file)); }
  finally { api[Comlink.releaseProxy](); worker.terminate(); }
}
