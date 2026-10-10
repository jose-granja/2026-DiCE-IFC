/**
 * Rewriting `IfcSite.RefLatitude` / `RefLongitude` / `RefElevation` in an
 * exported STEP file.
 *
 * The exporter's attribute edits write a list-valued attribute as text, which
 * would turn `(51,54,9,635411)` into a string. These two values are written
 * here instead, onto the one `IFCSITE` line, and nothing else in the file is
 * touched — so the signed original and every other byte stay as the exporter
 * wrote them.
 */

import { compoundAngleToStep } from "./compound-angle";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

/** Split the arguments of an entity at the top level, keeping nested lists and strings whole. */
export function splitStepArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "'") {
        if (text[i + 1] === "'") i += 1;
        else inString = false;
      }
    } else if (char === "'") inString = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    let k = 1;
    while (k < needle.length && haystack[i + k] === needle[k]) k += 1;
    if (k === needle.length) return i;
  }
  return -1;
}

export type SiteLocationEdit = {
  latitude?: number;
  longitude?: number;
  /** In the file's length unit, as `IfcSite.RefElevation` is. */
  elevation?: number;
};

/** A number as a STEP REAL: always with a decimal point, exponent in capitals. */
export function toStepReal(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("A length must be a finite number.");
  const text = String(value);
  if (/e/i.test(text)) return /\./.test(text) ? text.toUpperCase() : text.replace(/e/i, ".E").toUpperCase();
  return text.includes(".") ? text : `${text}.`;
}

/**
 * Set the site's latitude and/or longitude (decimal degrees) and/or elevation
 * on its `IFCSITE` line. `indices` are the attribute positions of
 * `RefLatitude`, `RefLongitude` and `RefElevation` for the file's schema. Returns the new bytes, or null when
 * there is no site line to edit.
 */
export function writeSiteLocation(
  content: Uint8Array,
  expressId: number | undefined,
  edit: SiteLocationEdit,
  indices: { latitude: number; longitude: number; elevation?: number },
): Uint8Array | null {
  const needle = encoder.encode("IFCSITE(");
  let found: { open: number; line: number } | null = null;

  for (let at = indexOfBytes(content, needle, 0); at >= 0; at = indexOfBytes(content, needle, at + 1)) {
    // `#12= IFCSITE(` — walk back over spaces and `=` to the id.
    let k = at - 1;
    while (k >= 0 && (content[k] === 0x20 || content[k] === 0x3d)) k -= 1;
    const end = k + 1;
    while (k >= 0 && content[k] >= 0x30 && content[k] <= 0x39) k -= 1;
    if (k < 0 || content[k] !== 0x23) continue;
    const id = Number(decoder.decode(content.subarray(k + 1, end)));
    const candidate = { open: at + needle.length - 1, line: k };
    if (id === expressId) {
      found = candidate;
      break;
    }
    found ??= candidate;
  }
  if (!found) return null;

  // Find the matching close paren, skipping strings.
  let depth = 0;
  let inString = false;
  let close = -1;
  for (let i = found.open; i < content.length; i += 1) {
    const byte = content[i];
    if (inString) {
      if (byte === 0x27) {
        if (content[i + 1] === 0x27) i += 1;
        else inString = false;
      }
    } else if (byte === 0x27) inString = true;
    else if (byte === 0x28) depth += 1;
    else if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;

  const args = splitStepArguments(decoder.decode(content.subarray(found.open + 1, close)));
  if (edit.latitude !== undefined && indices.latitude < args.length) {
    args[indices.latitude] = compoundAngleToStep(edit.latitude);
  }
  if (edit.longitude !== undefined && indices.longitude < args.length) {
    args[indices.longitude] = compoundAngleToStep(edit.longitude);
  }

  if (
    edit.elevation !== undefined &&
    indices.elevation !== undefined &&
    indices.elevation >= 0 &&
    indices.elevation < args.length
  ) {
    args[indices.elevation] = toStepReal(edit.elevation);
  }

  const replacement = encoder.encode(args.join(","));
  const out = new Uint8Array(content.length - (close - found.open - 1) + replacement.length);
  out.set(content.subarray(0, found.open + 1), 0);
  out.set(replacement, found.open + 1);
  out.set(content.subarray(close), found.open + 1 + replacement.length);
  return out;
}
