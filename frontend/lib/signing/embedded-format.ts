/** buildingSMART comment signature framing. See ADR 011 and its reference verifier. */
import { base64, fromBase64 } from "./canonical";
import { concat } from "./der";

export type EmbeddedIfcErrorCode = "invalid-ifc" | "non-ascii" | "already-signed" |
  "invalid-signature" | "unsigned-file" | "unsupported-format";
export class EmbeddedIfcError extends Error {
  constructor(readonly code: EmbeddedIfcErrorCode) { super(code); this.name = "EmbeddedIfcError"; }
}

/**
 * Cheap signature discovery before strict parsing. Unsigned IFC files can use
 * encodings or STEP variants the embedded signature profile does not support;
 * they must remain ordinary models, not acquire a failed-signature badge.
 * Ignore quoted STEP values and other comments, but include malformed signature
 * declarations so a damaged block is never silently reported as unsigned.
 * Scan bytes in the worker without allocating a normalized copy of a large IFC.
 */
export function hasEmbeddedSignature(bytes: Uint8Array): boolean {
  const next = (offset: number) => {
    while (offset < bytes.length && (bytes[offset] < 0x20 || bytes[offset] === 0x7f)) offset++;
    return offset;
  };
  const keyword = "SIGNATURE";
  let quote = 0;
  for (let i = next(0); i < bytes.length; i = next(i + 1)) {
    const byte = bytes[i], following = next(i + 1);
    if (quote) {
      if (byte === quote) {
        if (quote === 0x27 && bytes[following] === quote) i = following;
        else quote = 0;
      }
      continue;
    }
    if (byte === 0x27 || byte === 0x22) { quote = byte; continue; }
    if (byte !== 0x2f || bytes[following] !== 0x2a) continue;
    let cursor = next(following + 1);
    while (bytes[cursor] === 0x20) cursor = next(cursor + 1);
    let matched = 0;
    while (matched < keyword.length && (bytes[cursor] | 0x20) === (keyword.charCodeAt(matched) | 0x20)) {
      matched++;
      cursor = next(cursor + 1);
    }
    const boundary = bytes[cursor];
    if (matched === keyword.length && !(boundary >= 0x41 && boundary <= 0x5a) &&
      !(boundary >= 0x61 && boundary <= 0x7a) && !(boundary >= 0x30 && boundary <= 0x39) && boundary !== 0x5f) return true;
    // Comments are not nested. A marker in ordinary comment prose is not a
    // declaration and must not be interpreted as a second comment.
    let end = next(following + 1);
    while (end < bytes.length) {
      const after = next(end + 1);
      if (bytes[end] === 0x2a && bytes[after] === 0x2f) break;
      end = after;
    }
    i = next(end + 1);
  }
  return false;
}

/** Matches buildingSMART normalization: remove controls, retain spaces.
 * Refuse non-ASCII instead of silently changing the STEP encoding. */
export function normalizeIfc(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (const byte of bytes) {
    if (byte > 0x7f) throw new EmbeddedIfcError("non-ascii");
    if (byte >= 0x20 && byte !== 0x7f) out[length++] = byte;
  }
  return out.subarray(0, length);
}

export type EmbeddedBlock = { start: number; cms: Uint8Array };
/** Lex STEP strings/comments before looking for signature blocks. A marker in
 * an IFC property value is not a signature, nor can it terminate the model. */
export function inspectEmbeddedIfc(bytes: Uint8Array): { normalized: Uint8Array; blocks: EmbeddedBlock[] } {
  const normalized = normalizeIfc(bytes);
  const text = new TextDecoder().decode(normalized);
  const blocks: EmbeddedBlock[] = [];
  let phase: "start" | "header" | "header-fields" | "data" | "entities" | "end" | "done" = "start";
  let schema = false, description = false, fileName = false;
  let statementStart = -1;
  let quote: string | null = null;
  const invalid = () => { throw new EmbeddedIfcError("invalid-ifc"); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) invalid();
      const comment = text.slice(i, end + 2);
      if (/^\/\* *SIGNATURE;/.test(comment)) {
        if (phase !== "done" || statementStart !== -1) invalid();
        const match = /^\/\* *SIGNATURE; *([A-Za-z0-9+/= ]+) *ENDSEC; *\*\/$/.exec(comment);
        if (!match || comment.length > 1400000) throw new EmbeddedIfcError("invalid-signature");
        const encoded = match[1].replace(/ /g, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new EmbeddedIfcError("invalid-signature");
        }
        blocks.push({ start: i, cms: fromBase64(encoded) });
        if (blocks.length > 16) throw new EmbeddedIfcError("unsupported-format");
      } else if (blocks.length) {
        // Every normalized byte after the first signature must belong to a
        // signature block. Do not report a valid prefix of an altered file.
        throw new EmbeddedIfcError("invalid-signature");
      }
      i = end + 1;
      continue;
    }
    if (blocks.length) throw new EmbeddedIfcError("invalid-signature");
    if (char === " " && statementStart === -1) continue;
    if (phase === "done") invalid();
    if (statementStart === -1) statementStart = i;
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char !== ";") continue;
    // Entity records need no parsing or reserialization. Only STEP section
    // boundaries and the IFC schema header are checked here, not model validity.
    const statement = text.slice(statementStart, i).trim();
    statementStart = -1;
    switch (phase) {
      case "start": if (statement !== "ISO-10303-21") invalid(); phase = "header"; break;
      case "header": if (statement !== "HEADER") invalid(); phase = "header-fields"; break;
      case "header-fields":
        if (statement === "ENDSEC") {
          if (!schema || !description || !fileName) invalid();
          phase = "data";
        } else if (/^FILE_SCHEMA *\( *\( *'IFC[A-Z0-9_]+' *\) *\)$/.test(statement)) schema = true;
        else if (/^FILE_DESCRIPTION *\(/.test(statement)) description = true;
        else if (/^FILE_NAME *\(/.test(statement)) fileName = true;
        else invalid();
        break;
      case "data": if (statement !== "DATA") invalid(); phase = "entities"; break;
      case "entities":
        if (statement === "ENDSEC") phase = "end";
        else if (!/^#\d+ *=/.test(statement)) invalid();
        break;
      case "end": if (statement !== "END-ISO-10303-21") invalid(); phase = "done"; break;
    }
  }
  if (phase !== "done" || statementStart !== -1 || quote) invalid();
  return { normalized, blocks };
}

export function appendEmbeddedSignature(original: Uint8Array, cms: Uint8Array): Uint8Array {
  const encoded = base64(cms).match(/.{1,64}/g)!.join("\n");
  return concat(original, new TextEncoder().encode(`\n/*\nSIGNATURE;\n${encoded}\nENDSEC;\n*/\n`));
}
