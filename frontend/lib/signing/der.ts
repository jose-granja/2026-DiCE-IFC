/**
 * Just enough ASN.1 DER to read an X.509 certificate — and, for tests, to build
 * one.
 *
 * Reading is what verification needs: the signature carries the signing
 * certificate, and to check the signature we need its `SubjectPublicKeyInfo` in
 * a form WebCrypto's `importKey("spki", …)` accepts, plus the subject, issuer,
 * serial and validity for display and for the audit row.
 *
 * A full X.509 library would be a large dependency for that. This walks the
 * structure positionally, which is safe here because the layout is fixed by
 * RFC 5280:
 *
 * ```
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * TBSCertificate ::= SEQUENCE {
 *   [0] version OPTIONAL, serialNumber, signature, issuer,
 *   validity, subject, subjectPublicKeyInfo, … }
 * ```
 *
 * It deliberately does **not** validate a certificate chain, check key usage or
 * parse extensions. `verify.ts` says plainly what it did and did not check
 * rather than implying more assurance than there is.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type DerNode = {
  tag: number;
  /** Contents, excluding tag and length. */
  content: Uint8Array;
  /** Tag, length and contents — what to re-emit to preserve the encoding. */
  full: Uint8Array;
};

export function readNode(bytes: Uint8Array, offset = 0): DerNode {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > bytes.length) {
    throw new Error("Truncated DER value.");
  }
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor];
  cursor += 1;

  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) {
      throw new Error("Unsupported DER length encoding.");
    }
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[cursor];
      cursor += 1;
    }
  }

  if (cursor + length > bytes.length) throw new Error("Truncated DER content.");

  return {
    tag,
    content: bytes.subarray(cursor, cursor + length),
    full: bytes.subarray(offset, cursor + length),
  };
}

/** Every direct child of a constructed node. */
export function readChildren(node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const child = readNode(node.content, offset);
    children.push(child);
    offset += child.full.length;
  }
  return children;
}

export type CertificateInfo = {
  /** DER `SubjectPublicKeyInfo`, ready for `crypto.subtle.importKey("spki", …)`. */
  spki: Uint8Array;
  subject: string;
  issuer: string;
  /** Uppercase hex, as certificate viewers show it. */
  serial: string;
  notBefore: string;
  notAfter: string;
  keyType: "RSA" | "EC";
};

const OID_RSA = "1.2.840.113549.1.1.1";
const OID_EC = "1.2.840.10045.2.1";

export function readCertificate(der: Uint8Array): CertificateInfo {
  const certificate = readNode(der);
  const [tbs] = readChildren(certificate);
  const fields = readChildren(tbs);

  // [0] EXPLICIT version is optional; when absent everything shifts by one.
  const versioned = fields[0].tag === 0xa0;
  const at = (index: number) => fields[index + (versioned ? 1 : 0)];

  const serial = at(0);
  const issuer = at(2);
  const validity = at(3);
  const subject = at(4);
  const spki = at(5);

  const [notBefore, notAfter] = readChildren(validity);
  const [algorithm] = readChildren(spki);
  const [algorithmOid] = readChildren(algorithm);
  const oid = readOid(algorithmOid.content);

  return {
    spki: spki.full,
    subject: readName(subject),
    issuer: readName(issuer),
    serial: hex(serial.content).replace(/^00/, "").toUpperCase(),
    notBefore: readTime(notBefore),
    notAfter: readTime(notAfter),
    keyType: oid === OID_EC ? "EC" : oid === OID_RSA ? "RSA" : "RSA",
  };
}

/** An RFC 4514-ish string. For display and the audit row, not for comparison. */
function readName(name: DerNode): string {
  const parts: string[] = [];

  for (const rdn of readChildren(name)) {
    for (const attribute of readChildren(rdn)) {
      const [type, value] = readChildren(attribute);
      const label = SHORT_NAMES[readOid(type.content)] ?? readOid(type.content);
      parts.push(`${label}=${new TextDecoder().decode(value.content)}`);
    }
  }

  return parts.join(", ");
}

const SHORT_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.5": "SERIALNUMBER",
  "1.2.840.113549.1.9.1": "E",
};

function readTime(node: DerNode): string {
  const raw = new TextDecoder().decode(node.content);

  // UTCTime is YYMMDDHHMMSSZ with a 1950–2049 window; GeneralizedTime is
  // YYYYMMDDHHMMSSZ.
  const [year, rest] =
    node.tag === 0x17
      ? [
          Number(raw.slice(0, 2)) >= 50
            ? `19${raw.slice(0, 2)}`
            : `20${raw.slice(0, 2)}`,
          raw.slice(2),
        ]
      : [raw.slice(0, 4), raw.slice(4)];

  return `${year}-${rest.slice(0, 2)}-${rest.slice(2, 4)}T${rest.slice(4, 6)}:${rest.slice(6, 8)}:${rest.slice(8, 10)}Z`;
}

export function readOid(content: Uint8Array): string {
  const parts = [Math.floor(content[0] / 40), content[0] % 40];
  let value = 0;

  for (let index = 1; index < content.length; index += 1) {
    value = value * 128 + (content[index] & 0x7f);
    if (!(content[index] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }

  return parts.join(".");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
//
// Only the software signing provider uses this, to mint a real certificate
// around a WebCrypto key pair. That is what lets the test suite verify a
// signature it actually produced, for both RSA and ECDSA, with no card and no
// SoftHSM installation.

export function encode(tag: number, content: Uint8Array): Uint8Array {
  const length = encodeLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const sequence = (...children: Uint8Array[]) => encode(0x30, concat(...children));
export const set = (...children: Uint8Array[]) => encode(0x31, concat(...children));

export function integer(value: number | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    // A leading bit of 1 would read as negative, so pad.
    return encode(0x02, value[0] & 0x80 ? concat(Uint8Array.of(0), value) : value);
  }

  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  } while (remaining > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);

  return encode(0x02, Uint8Array.from(bytes));
}

export function bitString(content: Uint8Array): Uint8Array {
  // Leading byte is the count of unused bits in the final octet; always 0 here.
  return encode(0x03, concat(Uint8Array.of(0), content));
}

export function utf8String(value: string): Uint8Array {
  return encode(0x0c, new TextEncoder().encode(value));
}

export function oid(value: string): Uint8Array {
  const parts = value.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];

  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let remaining = part;
    do {
      chunks.unshift(remaining & 0x7f);
      remaining >>= 7;
    } while (remaining > 0);
    for (let index = 0; index < chunks.length - 1; index += 1) chunks[index] |= 0x80;
    bytes.push(...chunks);
  }

  return encode(0x06, Uint8Array.from(bytes));
}

export function utcTime(at: Date): Uint8Array {
  const pad = (value: number) => String(value).padStart(2, "0");
  const text =
    pad(at.getUTCFullYear() % 100) +
    pad(at.getUTCMonth() + 1) +
    pad(at.getUTCDate()) +
    pad(at.getUTCHours()) +
    pad(at.getUTCMinutes()) +
    pad(at.getUTCSeconds()) +
    "Z";

  return encode(0x17, new TextEncoder().encode(text));
}

export const explicit = (index: number, content: Uint8Array) =>
  encode(0xa0 | index, content);

export const nullValue = () => encode(0x05, new Uint8Array());

/** `CN=…, C=PT` → a `Name`. */
export function name(entries: Array<[string, string]>): Uint8Array {
  const byLabel: Record<string, string> = {
    CN: "2.5.4.3",
    C: "2.5.4.6",
    O: "2.5.4.10",
    OU: "2.5.4.11",
    SERIALNUMBER: "2.5.4.5",
  };

  return sequence(
    ...entries.map(([label, value]) =>
      set(sequence(oid(byLabel[label] ?? "2.5.4.3"), utf8String(value))),
    ),
  );
}
