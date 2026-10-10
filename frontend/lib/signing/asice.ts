/**
 * ASiC-E containers (ETSI EN 319 162).
 *
 * A `.ifczip` is a ZIP holding an `.ifc`; a `.bcf` is already a ZIP. Neither
 * has a signature slot, so the signature goes in `META-INF/` where ASiC-E puts
 * it. **The archive stays a valid ifcZIP/bcf for every other tool** — nothing
 * is moved or renamed, only added — and signature-aware tools read `META-INF/`.
 *
 * ```
 * model.ifczip
 * ├── mimetype                     application/vnd.etsi.asic-e+zip, stored first
 * ├── model.ifc                    the original bytes, untouched
 * └── META-INF/
 *     ├── manifest.xml
 *     └── signatures001.xml        XAdES
 * ```
 *
 * ## Co-signing
 *
 * ASiC-E numbers signature files, so a second signer adds `signatures002.xml`
 * beside the first rather than replacing it. Author, then reviewer, then
 * coordinator is therefore a natively supported case and needs no special
 * format — `addSignature` finds the next free number. Each signature covers the
 * payload independently, so removing one does not invalidate the others.
 *
 * ## The mimetype entry
 *
 * ASiC requires `mimetype` to be the **first** entry and **stored, not
 * deflated**, so a reader can identify the container from the first bytes of
 * the file without inflating anything. `fflate`'s per-file `level: 0` gives
 * that; being first is a property of insertion order.
 */

import { unzipSync, zipSync } from "fflate";

import { wrapAsicSignatures } from "./xades";

export const ASIC_MIMETYPE = "application/vnd.etsi.asic-e+zip";
const MANIFEST_NS = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";

export type ContainerEntry = {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
};

/** Signature file names, in order. `META-INF/signatures001.xml`, … */
export function signatureFileName(index: number): string {
  return `META-INF/signatures${String(index).padStart(3, "0")}.xml`;
}

export function listSignatureFiles(entries: Record<string, Uint8Array>): string[] {
  return Object.keys(entries)
    .filter((path) => /^META-INF\/signatures\d+\.xml$/i.test(path))
    .sort();
}

/**
 * Build a container from payload files and one signature.
 *
 * The payload bytes are written exactly as given. Re-serialising a model here
 * would reorder STEP instances and rewrite the header, and the signature — taken
 * over the bytes as read — would no longer match its own payload.
 */
export function createContainer(
  entries: ContainerEntry[],
  signatureXml: string,
): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};

  // First and stored, per ASiC.
  files["mimetype"] = [new TextEncoder().encode(ASIC_MIMETYPE), { level: 0 }];

  for (const entry of entries) {
    files[entry.name] = [entry.bytes, { level: 6 }];
  }

  files["META-INF/manifest.xml"] = [
    new TextEncoder().encode(buildManifest(entries)),
    { level: 6 },
  ];
  files[signatureFileName(1)] = [
    new TextEncoder().encode(wrapAsicSignatures(signatureXml)),
    { level: 6 },
  ];

  return zipSync(files as Parameters<typeof zipSync>[0]);
}

/**
 * Add a signature to an existing container, as the next `signaturesNNN.xml`.
 *
 * Every other entry is copied through byte for byte, including the signatures
 * already there — a co-signature must not disturb what it is joining.
 */
export function addSignature(
  container: Uint8Array,
  signatureXml: string,
): Uint8Array {
  const existing = unzipSync(container);
  const next = listSignatureFiles(existing).length + 1;

  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  files["mimetype"] = [
    existing["mimetype"] ?? new TextEncoder().encode(ASIC_MIMETYPE),
    { level: 0 },
  ];

  for (const [path, bytes] of Object.entries(existing)) {
    if (path === "mimetype") continue;
    files[path] = [bytes, { level: 6 }];
  }

  files[signatureFileName(next)] = [
    new TextEncoder().encode(wrapAsicSignatures(signatureXml)),
    { level: 6 },
  ];

  return zipSync(files as Parameters<typeof zipSync>[0]);
}

/** Payload entries — everything that is not container metadata. */
export function payloadEntries(
  entries: Record<string, Uint8Array>,
): Array<{ name: string; bytes: Uint8Array }> {
  return Object.entries(entries)
    .filter(([path]) => path !== "mimetype" && !path.startsWith("META-INF/"))
    .map(([name, bytes]) => ({ name, bytes }));
}

/**
 * The OpenDocument-style manifest ASiC-E inherits.
 *
 * Written by hand rather than through `canonical.ts`: nothing hashes this, so
 * it is presentation, and the indentation makes it readable when someone
 * unzips a container to see what went wrong.
 */
function buildManifest(entries: ContainerEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<manifest:manifest xmlns:manifest="${MANIFEST_NS}" manifest:version="1.2">`,
    `  <manifest:file-entry manifest:full-path="/" manifest:media-type="${ASIC_MIMETYPE}"/>`,
  ];

  for (const entry of entries) {
    lines.push(
      `  <manifest:file-entry manifest:full-path="${escapeAttribute(entry.name)}" manifest:media-type="${escapeAttribute(entry.mimeType)}"/>`,
    );
  }

  lines.push("</manifest:manifest>", "");
  return lines.join("\n");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** `model.ifc` → `model.ifczip`; a BCF set keeps `.bcf` — it was a zip already. */
export function containerFileName(name: string, kind: "ifc" | "bcf"): string {
  const base = name.replace(/\.(ifc|ifczip|bcf|bcfzip)$/i, "");
  return kind === "ifc" ? `${base}.ifczip` : `${base}.bcf`;
}

export function mimeTypeFor(name: string): string {
  if (/\.ifc$/i.test(name)) return "application/x-step";
  if (/\.ifcxml$/i.test(name)) return "application/xml";
  if (/\.(bcf|bcfzip)$/i.test(name)) return "application/octet-stream";
  return "application/octet-stream";
}
