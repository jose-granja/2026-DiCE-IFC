"use client";

import { signEmbeddedIfc } from "./embedded";
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
  /** What happened when a time-stamp was asked for; absent when none was (and always, for embedded signatures). */
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
  /** Time-stamp each IFCZIP signature. Not applicable to embedded CMS signatures. */
  timestamper?: SignOptions["timestamper"];
};

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
  const result: BatchResult = { outputs: [], failures: [], cancelled: false };
  const device = pinBatchCertificate(provider);
  const usedNames = new Set<string>();
  const emit = (output: BatchOutput) => {
    output.name = uniqueName(output.name, usedNames);
    result.outputs.push(output);
    options.onOutput?.(output);
  };

  if (options.format === "ifczip" && options.mode === "combined") {
    const inputs: FileToSign[] = [];
    for (const [index, file] of files.entries()) {
      options.onProgress?.({ phase: "reading", current: index + 1, total: files.length, fileName: file.name });
      try { inputs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
      catch (error) {
        result.failures.push({ fileName: file.name, error });
        return result;
      }
    }
    let signed;
    try {
      signed = await signFiles(inputs, device, {
        mode: "combined", kind: "ifc", timestamper: options.timestamper,
        onProgress: (progress) => options.onProgress?.({
          ...progress, current: progress.phase === "done" ? files.length : Math.max(1, progress.current),
        }),
      });
    } catch (error) {
      result.failures.push(...files.map((file) => ({ fileName: file.name, error })));
      result.cancelled = error instanceof SigningError && error.code === "cancelled";
      return result;
    }
    for (const output of signed) emit({ ...output, format: "ifczip" });
    return result;
  }

  for (const [index, file] of files.entries()) {
    const progress = (phase: BatchProgress["phase"]) => options.onProgress?.({
      phase, current: index + 1, total: files.length, fileName: file.name,
    });
    let outputs: BatchOutput[];
    if (options.format === "embedded") {
      try {
        const output = await signEmbeddedIfc(file, device, {
          onProgress: (phase) => progress(phase === "signing" ? "awaiting-pin" : phase),
        });
        outputs = [{ ...output, covers: [file.name], format: "embedded" }];
      } catch (error) {
        result.failures.push({ fileName: file.name, error });
        result.cancelled = error instanceof SigningError && error.code === "cancelled";
        if (error instanceof EmbeddedIfcError) continue;
        break;
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
          mode: "per-file", kind: "ifc", timestamper: options.timestamper,
          onProgress: ({ phase }) => progress(phase),
        })).map((output) => ({ ...output, format: "ifczip" as const }));
      } catch (error) {
        result.failures.push({ fileName: file.name, error });
        result.cancelled = error instanceof SigningError && error.code === "cancelled";
        break;
      }
    }
    for (const output of outputs) emit(output);
    progress("done");
  }
  return result;
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
