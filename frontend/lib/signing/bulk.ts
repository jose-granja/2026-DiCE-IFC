"use client";

import { cosignContainer, CosignError } from "./cosign";
import { cosignEmbeddedIfc, signEmbeddedIfc } from "./embedded";
import type { SignatureDetails } from "./details";
import { EmbeddedIfcError } from "./embedded-format";
import { SigningError, type SigningCertificate, type SigningProvider } from "./provider";
import { signFiles, type FileToSign, type SignMode, type SignedOutput, type SignOptions } from "./sign";

export type IfcSigningFormat = "ifczip" | "embedded";
export type BatchOutput = {
  name: string;
  bytes: Uint8Array;
  covers: string[];
  format: IfcSigningFormat;
  certificate?: SigningCertificate;
  signingTime?: string;
  /** What happened when a time-stamp was asked for; absent when none was. */
  timestamp?: SignedOutput["timestamp"];
};
export type BatchProgress = {
  current: number;
  total: number;
  fileName?: string;
  phase: "reading" | "certificate" | "preparing" | "awaiting-pin" | "timestamping" | "assembling" | "verifying" | "done";
};
export type BatchResult = {
  outputs: BatchOutput[];
  failures: Array<{ fileName: string; error: unknown }>;
  /** True only when the citizen dismissed the signing dialog. */
  cancelled: boolean;
};
export type BulkSigningErrorCode = "empty-selection" | "duplicate-name" | "unsupported-format" | "invalid-mode";
export class BulkSigningError extends Error {
  constructor(readonly code: BulkSigningErrorCode, readonly fileName?: string) {
    super(code);
    this.name = "BulkSigningError";
  }
}

export type BatchOptions = {
  format: IfcSigningFormat;
  mode: SignMode;
  onProgress?: (progress: BatchProgress) => void;
  onOutput?: (output: BatchOutput) => void;
  /** Time-stamp each signature: XAdES-T in an IFCZIP, CAdES-T inside an IFC. */
  timestamper?: SignOptions["timestamper"];
  /**
   * Reason, place and attributes, signed into every signature of the batch.
   * Professional attributes go into IFCZIP signatures only; an embedded file
   * with some asked for is refused rather than signed without them.
   */
  details?: SignatureDetails;
};

/** One run over a queue: one card, one set of output names, one count. */
type Run = {
  result: BatchResult;
  device: SigningProvider;
  usedNames: Set<string>;
  /** Files already handled before this part of the run, for the progress count. */
  offset: number;
  total: number;
  onProgress?: (progress: BatchProgress) => void;
  onOutput?: (output: BatchOutput) => void;
};

function startRun(provider: SigningProvider, total: number, options: Pick<BatchOptions, "onProgress" | "onOutput">): Run {
  return {
    result: { outputs: [], failures: [], cancelled: false },
    device: pinBatchCertificate(provider),
    usedNames: new Set(),
    offset: 0,
    total,
    onProgress: options.onProgress,
    onOutput: options.onOutput,
  };
}

function emit(run: Run, output: BatchOutput) {
  output.name = uniqueName(output.name, run.usedNames);
  run.result.outputs.push(output);
  run.onOutput?.(output);
}

/**
 * Serialize card operations, retain completed downloads after a later failure,
 * and never retry a PIN operation. File-specific errors can skip one input;
 * device, signing and unexpected errors stop the queue. All IFC processing
 * stays in the existing local signing implementations.
 */
export async function signIfcBatch(
  files: File[],
  provider: SigningProvider,
  options: BatchOptions,
): Promise<BatchResult> {
  validateSelection(files, options);
  const run = startRun(provider, files.length, options);
  await signFresh(files, options, run);
  return run.result;
}

/** Sign files that carry no signature. Returns whether the run must stop. */
async function signFresh(files: File[], options: BatchOptions, run: Run): Promise<boolean> {
  const { result, device } = run;
  const at = (index: number) => run.offset + index + 1;

  if (options.format === "ifczip" && options.mode === "combined") {
    const inputs: FileToSign[] = [];
    for (const [index, file] of files.entries()) {
      run.onProgress?.({ phase: "reading", current: at(index), total: run.total, fileName: file.name });
      try { inputs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
      catch (error) {
        result.failures.push({ fileName: file.name, error });
        return true;
      }
    }
    let signed;
    try {
      signed = await signFiles(inputs, device, {
        mode: "combined", kind: "ifc", timestamper: options.timestamper, details: options.details,
        onProgress: (progress) => run.onProgress?.({
          ...progress,
          total: run.total,
          current: run.offset + (progress.phase === "done" ? files.length : Math.max(1, progress.current)),
        }),
      });
    } catch (error) {
      result.failures.push(...files.map((file) => ({ fileName: file.name, error })));
      result.cancelled = error instanceof SigningError && error.code === "cancelled";
      return true;
    }
    for (const output of signed) emit(run, { ...output, format: "ifczip" });
    return false;
  }

  for (const [index, file] of files.entries()) {
    const progress = (phase: BatchProgress["phase"]) => run.onProgress?.({
      phase, current: at(index), total: run.total, fileName: file.name,
    });
    let outputs: BatchOutput[];
    if (options.format === "embedded") {
      try {
        const output = await signEmbeddedIfc(file, device, {
          onProgress: (phase) => progress(phase === "signing" ? "awaiting-pin" : phase),
          details: embeddedDetails(options.details),
          timestamper: options.timestamper,
        });
        outputs = [{ ...output, covers: [file.name], format: "embedded" }];
      } catch (error) {
        result.failures.push({ fileName: file.name, error });
        result.cancelled = error instanceof SigningError && error.code === "cancelled";
        if (error instanceof EmbeddedIfcError) continue;
        return true;
      }
    } else {
      progress("reading");
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); }
      catch (error) {
        result.failures.push({ fileName: file.name, error });
        continue;
      }
      try {
        outputs = (await signFiles([{ name: file.name, bytes }], device, {
          mode: "per-file", kind: "ifc", timestamper: options.timestamper, details: options.details,
          onProgress: ({ phase }) => progress(phase),
        })).map((output) => ({ ...output, format: "ifczip" as const }));
      } catch (error) {
        result.failures.push({ fileName: file.name, error });
        result.cancelled = error instanceof SigningError && error.code === "cancelled";
        return true;
      }
    }
    for (const output of outputs) emit(run, output);
    progress("done");
  }
  return false;
}

/** What a co-signature joins: the IFCZIP container, or the signatures inside an IFC. */
export function cosignFormat(fileName: string): IfcSigningFormat | null {
  if (/\.ifczip$/i.test(fileName)) return "ifczip";
  if (/\.ifc$/i.test(fileName)) return "embedded";
  return null;
}

/**
 * Add the card holder's signature to files that are already signed
 * (`cosign.ts`), one at a time and one PIN each, keeping each file's own
 * format. A file that must not be co-signed — unsigned, altered, already
 * signed by this card — is skipped with its reason before the card is asked;
 * device errors and cancellation stop the queue, as for signing.
 */
export async function cosignIfcBatch(
  files: File[],
  provider: SigningProvider,
  options: Omit<BatchOptions, "format" | "mode">,
): Promise<BatchResult> {
  validateCosignSelection(files);
  const run = startRun(provider, files.length, options);
  await cosignSigned(files, options, run);
  return run.result;
}

function validateCosignSelection(files: File[]) {
  if (!files.length) throw new BulkSigningError("empty-selection");
  const names = new Set<string>();
  for (const file of files) {
    const name = file.name.normalize("NFC").toLowerCase();
    if (names.has(name)) throw new BulkSigningError("duplicate-name", file.name);
    names.add(name);
    if (!cosignFormat(file.name)) throw new BulkSigningError("unsupported-format", file.name);
  }
}

/** Co-sign files that carry signatures. Returns whether the run must stop. */
async function cosignSigned(
  files: File[],
  options: Omit<BatchOptions, "format" | "mode">,
  run: Run,
): Promise<boolean> {
  const { result, device } = run;
  for (const [index, file] of files.entries()) {
    const current = run.offset + index + 1;
    const progress = (phase: BatchProgress["phase"]) => run.onProgress?.({
      phase, current, total: run.total, fileName: file.name,
    });
    let output: BatchOutput;
    try {
      if (cosignFormat(file.name) === "embedded") {
        const signed = await cosignEmbeddedIfc(file, device, {
          onProgress: (phase) => progress(phase === "signing" ? "awaiting-pin" : phase),
          details: embeddedDetails(options.details),
          timestamper: options.timestamper,
        });
        output = { ...signed, covers: [file.name], format: "embedded" };
      } else {
        progress("reading");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const signed = await cosignContainer({ name: file.name, bytes }, device, {
          timestamper: options.timestamper,
          details: options.details,
          current,
          total: run.total,
          onProgress: ({ phase }) => progress(phase),
        });
        output = { ...signed, format: "ifczip" };
      }
    } catch (error) {
      result.failures.push({ fileName: file.name, error });
      result.cancelled = error instanceof SigningError && error.code === "cancelled";
      // This file's problem, not the card's: go on with the next one.
      if (error instanceof CosignError || error instanceof EmbeddedIfcError) continue;
      return true;
    }
    emit(run, output);
    progress("done");
  }
  return false;
}

/**
 * Sign a queue whatever each file already carries, so nobody has to say which
 * is which: a file with no signature is signed in the chosen `format` (and
 * `mode`); a file that is already signed gets this card's signature added in
 * its own format (`cosign.ts`), with every check that implies. `isSigned` is
 * what the page found when it read each file — the same reading it shows.
 *
 * Unsigned files go first, then signed ones, under one card, one count and one
 * set of output names. A cancelled PIN or a device error stops the whole run.
 */
export async function signIfcFiles(
  files: File[],
  provider: SigningProvider,
  options: BatchOptions & { isSigned: (file: File) => boolean },
): Promise<BatchResult> {
  if (!files.length) throw new BulkSigningError("empty-selection");
  const fresh = files.filter((file) => !options.isSigned(file));
  const signed = files.filter((file) => options.isSigned(file));
  // Names must be unique across the whole queue, whichever way each file goes.
  const names = new Set<string>();
  for (const file of files) {
    const name = file.name.normalize("NFC").toLowerCase();
    if (names.has(name)) throw new BulkSigningError("duplicate-name", file.name);
    names.add(name);
  }
  if (fresh.length) validateSelection(fresh, options);
  if (signed.length) validateCosignSelection(signed);

  const run = startRun(provider, files.length, options);
  if (fresh.length && (await signFresh(fresh, options, run))) return run.result;
  run.offset = fresh.length;
  if (signed.length) await cosignSigned(signed, options, run);
  return run.result;
}

/**
 * The details an embedded (CMS) signature can carry. Certified attributes have
 * no place there yet (ADR 019), and signing without the ones the citizen chose
 * would be a quieter wrong than refusing.
 */
function embeddedDetails(details: SignatureDetails | undefined) {
  if (details?.professionalAttributes?.length) {
    throw new EmbeddedIfcError("unsupported-format");
  }
  return details;
}

function validateSelection(files: File[], options: BatchOptions) {
  if (!files.length) throw new BulkSigningError("empty-selection");
  if (options.format === "embedded" && options.mode !== "per-file") {
    throw new BulkSigningError("invalid-mode");
  }
  const names = new Set<string>();
  for (const file of files) {
    const name = file.name.normalize("NFC").toLowerCase();
    if (names.has(name)) throw new BulkSigningError("duplicate-name", file.name);
    names.add(name);
    const allowed = options.format === "embedded" ? /\.ifc$/i : /\.(ifc|ifcxml|ifczip)$/i;
    if (!allowed.test(file.name)) throw new BulkSigningError("unsupported-format", file.name);
  }
}

/** Do not let replacing the card silently change the signer half way through. */
function pinBatchCertificate(provider: SigningProvider): SigningProvider {
  let certificateDer: string | undefined;
  const check = (value: string) => {
    if (certificateDer !== undefined && value !== certificateDer) {
      throw new SigningError("card-changed", "The signing card changed during the batch.");
    }
    certificateDer = value;
  };
  return {
    id: provider.id,
    getReadiness: () => provider.getReadiness(),
    getSigningCertificate: async () => {
      const certificate = await provider.getSigningCertificate();
      check(certificate.certificateDer);
      return certificate;
    },
    sign: async (request) => {
      check(request.expectCertificateDer);
      const result = await provider.sign(request);
      check(result.certificateDer);
      return result;
    },
  };
}

function uniqueName(requested: string, used: Set<string>): string {
  const dot = requested.lastIndexOf(".");
  const stem = dot < 0 ? requested : requested.slice(0, dot);
  const extension = dot < 0 ? "" : requested.slice(dot);
  let name = requested;
  let suffix = 2;
  while (used.has(name.normalize("NFC").toLowerCase())) name = `${stem} (${suffix++})${extension}`;
  used.add(name.normalize("NFC").toLowerCase());
  return name;
}
