"use client";

import * as Comlink from "comlink";
import type { EmbeddedSigningWorkerApi } from "../workers/embedded-signing.worker";
import { prepareCms } from "./cms";
import { EmbeddedIfcError, type EmbeddedIfcErrorCode } from "./embedded-format";
import { SigningError, type SigningProvider } from "./provider";
export { EmbeddedIfcError } from "./embedded-format";

export type EmbeddedPhase = "reading" | "certificate" | "signing" | "verifying";
export type EmbeddedVerification = { signatures: Array<{
  valid: boolean; subject?: string; issuer?: string; signingTime?: string; algorithm?: string;
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

export async function signEmbeddedIfc(file: File, provider: SigningProvider, options: {
  onProgress?: (phase: EmbeddedPhase) => void;
} = {}) {
  const { worker, api } = openWorker(file);
  try {
    options.onProgress?.("reading");
    // Read and validate before asking for a card or triggering a PIN dialog.
    const contentDigest = value(await api.prepare(file));
    options.onProgress?.("certificate");
    const readiness = await provider.getReadiness();
    if (!readiness.ready) throw new SigningError("not-ready", "The card companion is not ready.");
    const certificate = await provider.getSigningCertificate();
    const at = new Date();
    const prepared = await prepareCms(contentDigest, certificate, at);
    options.onProgress?.("signing");
    // Only digest-bearing CMS metadata goes to localhost. The IFC stays in
    // the worker. The middleware owns the PIN dialog, exactly as for IFCZIP.
    const result = await provider.sign({ dataToBeSigned: prepared.dataToBeSigned,
      hash: prepared.hash, expectCertificateDer: certificate.certificateDer });
    options.onProgress?.("verifying");
    const bytes = value(await api.finish(prepared.complete(result)));
    return { bytes, name: file.name.replace(/\.ifc$/i, "-signed.ifc"), certificate, signingTime: at.toISOString() };
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
