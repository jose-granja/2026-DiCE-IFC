/**
 * Signing a set of files.
 *
 * Two modes, and the difference is a guarantee the user is entitled to
 * understand rather than an implementation detail:
 *
 * - **`per-file`** — one signature per file, one container per file, and **one
 *   PIN entry each**. Every container is independently verifiable and can be
 *   sent to a different recipient on its own.
 * - **`combined`** — one signature covering every file, in one container, with
 *   **one PIN entry**. Standards-legal (a XAdES signature may reference any
 *   number of data objects) and far better for a forty-model federation, but the
 *   files are no longer independently verifiable: pull one out of the container
 *   and its signature does not come with it.
 *
 * The brief's default is `combined` for a coherent model set. Neither is
 * hidden, and `/sign` states which guarantee is being produced.
 *
 * There is no PIN anywhere in this file, and there must never be one. The
 * device raises its own dialog — see ADR 004.
 */

import { unzipSync } from "fflate";

import {
  containerFileName,
  createContainer,
  mimeTypeFor,
  type ContainerEntry,
} from "./asice";
import {
  negotiateAlgorithm,
  SigningError,
  type SigningCertificate,
  type SigningProvider,
} from "./provider";
import { completeSignature, prepareSignature, signatureTimestampDigest } from "./xades";

export type SignMode = "per-file" | "combined";

export type FileToSign = {
  name: string;
  bytes: Uint8Array;
};

export type SignedOutput = {
  /** Container file name, e.g. `model.ifczip`. */
  name: string;
  bytes: Uint8Array;
  /** Files this container's signature covers. */
  covers: string[];
  /**
   * What happened when a time-stamp was asked for. Absent when none was. A
   * failure is reported rather than thrown: by then the citizen has typed the
   * PIN, and the signature is real — it is just B-B, not B-T, and the page says so.
   */
  timestamp?: { status: "added"; time: string; tsa?: string } | { status: "failed"; error: string };
};

export type SignProgress = {
  /** What the user is being asked for right now. */
  phase: "certificate" | "preparing" | "awaiting-pin" | "timestamping" | "assembling" | "done";
  /** 1-based, for `per-file`. */
  current: number;
  total: number;
  fileName?: string;
};

export type SignOptions = {
  mode?: SignMode;
  kind?: "ifc" | "bcf";
  /** Name for the combined container. Ignored in `per-file` mode. */
  containerName?: string;
  onProgress?: (progress: SignProgress) => void;
  /**
   * Stamp the finished signature: given the SHA-256 of its `SignatureValue`,
   * return a time-stamp token (base64 DER) and when it says it is. Not a URL and
   * not a fetch — the caller decides where a time-stamp comes from, so this
   * stays testable without a network.
   */
  timestamper?: (digest: Uint8Array) => Promise<{ token: string; time: string; tsa?: string }>;
  /** Injected in tests so output is byte-identical between runs. */
  now?: Date;
  idSuffix?: string;
};

export async function signFiles(
  files: FileToSign[],
  provider: SigningProvider,
  options: SignOptions = {},
): Promise<SignedOutput[]> {
  if (files.length === 0) throw new SigningError("unknown", "Nothing to sign.");

  const mode = options.mode ?? "combined";
  const kind = options.kind ?? "ifc";

  options.onProgress?.({ phase: "certificate", current: 0, total: files.length });
  const certificate = await provider.getSigningCertificate();

  if (mode === "combined") {
    const name =
      options.containerName ??
      containerFileName(files[0].name, kind).replace(/\.(ifczip|bcf)$/i, "-signed.$1");

    const group = await signGroup(files, certificate, provider, options, 1, files.length);
    return [
      {
        name,
        covers: files.map((file) => file.name),
        bytes: group.bytes,
        timestamp: group.timestamp,
      },
    ];
  }

  const outputs: SignedOutput[] = [];
  for (const [index, file] of files.entries()) {
    const group = await signGroup([file], certificate, provider, options, index + 1, files.length);
    outputs.push({
      name: containerFileName(file.name, kind),
      covers: [file.name],
      bytes: group.bytes,
      timestamp: group.timestamp,
    });
  }
  return outputs;
}

/**
 * The payload entries a container's signature will cover.
 *
 * An `.ifc` file is not a zip, so each one becomes one opaque entry —
 * wrapping it in a new zip alongside `META-INF/` is what produces the
 * `.ifczip`, and is the whole point. A `.bcf` file is *already* a zip
 * (topic folders, `bcf.version`, …), so treating it the same way nests a zip
 * inside a zip: the signed file's top level would hold one opaque
 * `issues.bcf` blob instead of the topics a BCF reader looks for, and
 * nothing — including this app's own importer — could open it. Its entries
 * are unzipped and become the container's own top-level entries instead, so
 * `META-INF/` really is the only thing added, matching ADR 002 and
 * `lib/bcf/parse.ts`'s `topicFolders()`, which finds a topic by its
 * `markup.bcf` wherever one sits and does not mind the `mimetype` /
 * `META-INF/` entries alongside it.
 *
 * More than one BCF file signed together (`combined` mode with several
 * files selected) can't all keep bare top-level names — two files' own
 * `bcf.version` would collide — so each file's entries are namespaced under
 * its own file name instead. That container is no longer one a BCF reader
 * opens directly; the same trade-off `combined` already makes for IFC, where
 * an `.ifczip` holding several `.ifc` files isn't itself one valid `.ifc`
 * either.
 */
function buildEntries(files: FileToSign[], kind: "ifc" | "bcf"): ContainerEntry[] {
  if (kind !== "bcf") {
    return files.map((file) => ({
      name: file.name,
      bytes: file.bytes,
      mimeType: mimeTypeFor(file.name),
    }));
  }

  const namespaced = files.length > 1;
  return files.flatMap((file) => {
    let inner: Record<string, Uint8Array>;
    try {
      inner = unzipSync(file.bytes);
    } catch (error) {
      throw new SigningError(
        "unknown",
        `${file.name} is not a readable BCF archive.`,
        error,
      );
    }

    const prefix = namespaced
      ? `${file.name.replace(/\.(bcf|bcfzip)$/i, "")}/`
      : "";
    return Object.entries(inner).map(([path, bytes]) => ({
      name: `${prefix}${path}`,
      bytes,
      mimeType: mimeTypeFor(path),
    }));
  });
}

/**
 * Prepare, sign, assemble.
 *
 * The certificate is passed to `sign` as `expectCertificateDer` so the device
 * can refuse if the card changed between preparing and signing — otherwise a
 * swapped card yields a signature over a `SignedInfo` naming someone else's
 * certificate, which verifies against nothing and is hard to diagnose.
 */
async function signGroup(
  files: FileToSign[],
  certificate: SigningCertificate,
  provider: SigningProvider,
  options: SignOptions,
  current: number,
  total: number,
): Promise<{ bytes: Uint8Array; timestamp?: SignedOutput["timestamp"] }> {
  const { algorithm } = negotiateAlgorithm(certificate);

  const entries = buildEntries(files, options.kind ?? "ifc");

  options.onProgress?.({
    phase: "preparing",
    current,
    total,
    fileName: files[0]?.name,
  });

  const prepared = await prepareSignature(entries, certificate, {
    algorithm,
    now: options.now,
    idSuffix: options.idSuffix,
  });

  options.onProgress?.({
    phase: "awaiting-pin",
    current,
    total,
    fileName: files[0]?.name,
  });

  const result = await provider.sign({
    dataToBeSigned: prepared.dataToBeSigned,
    hash: prepared.hash,
    expectCertificateDer: certificate.certificateDer,
  });

  if (result.algorithm !== algorithm) {
    // The device signed with something other than what SignedInfo declares, so
    // SignatureMethod would be a lie and no verifier would accept it.
    throw new SigningError(
      "unsupported-algorithm",
      `The card signed with ${result.algorithm} but the signature was prepared for ${algorithm}.`,
    );
  }

  let timestamp: SignedOutput["timestamp"];
  let timestampToken: string | undefined;
  if (options.timestamper) {
    options.onProgress?.({ phase: "timestamping", current, total, fileName: files[0]?.name });
    try {
      const stamped = await options.timestamper(
        await signatureTimestampDigest(prepared.context, result.signatureValue),
      );
      timestampToken = stamped.token;
      timestamp = { status: "added", time: stamped.time, tsa: stamped.tsa };
    } catch (error) {
      timestamp = {
        status: "failed",
        error: error instanceof Error ? error.message : "The time-stamp could not be obtained.",
      };
    }
  }

  options.onProgress?.({ phase: "assembling", current, total });

  const signatureXml = completeSignature(prepared.context, result.signatureValue, { timestampToken });
  const container = createContainer(entries, signatureXml);

  options.onProgress?.({ phase: "done", current, total });
  return { bytes: container, timestamp };
}
