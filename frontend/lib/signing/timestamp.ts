/**
 * RFC 3161 time-stamp requests and tokens — the part of XAdES-T that the card
 * cannot do.
 *
 * A signature carries the time its author *claims*. A time-stamp is a third
 * party's signed statement that a given hash existed at a given moment, and it
 * is what turns "signed at 10:42" from an assertion into evidence — and what
 * lets a signature outlive the certificate that made it. A *qualified* one
 * (eIDAS art. 41) also carries a legal presumption that the time is accurate.
 *
 * ## What crosses the wire
 *
 * A time-stamp request holds a hash and a nonce. Nothing else: not the file, not
 * its name, not who is asking. `SignatureValue` — the thing being stamped — is
 * itself already a signature over digests, so even the hash reveals nothing
 * about the content. See ADR 012.
 *
 * ## Shared by both sides
 *
 * The request is built, and the response checked, by the route handler
 * (`app/api/tsa/route.ts`), and the token is read again in the browser — to
 * check it stamps *this* signature before it is embedded, and by the verifier to
 * report what a container's token says. So this is plain functions over bytes.
 *
 * ## What is not done here
 *
 * The token's own CMS signature, and whether its signer is a qualified
 * time-stamping service, are **not** verified. That needs the EU/PT trusted
 * list (a fetch the browser cannot make), and it is the same gap as for the
 * signer's own certificate — `verify.ts` says so rather than implying otherwise.
 */

import {
  encode,
  integer,
  nullValue,
  oid,
  readCertificate,
  readChildren,
  readNode,
  readOid,
  sequence,
  type DerNode,
} from "./der";

const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";

/** Everything a time-stamp request is asked to say. */
export type TimestampRequest = {
  /** SHA-256 of what is being stamped. */
  digest: Uint8Array;
  /** Random, returned by the TSA, so a replayed answer is recognisable. */
  nonce: Uint8Array;
};

export const TIMESTAMP_REQUEST_TYPE = "application/timestamp-query";
export const TIMESTAMP_REPLY_TYPE = "application/timestamp-reply";

export function randomNonce(): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  // A positive INTEGER: the top bit would read as a sign.
  nonce[0] &= 0x7f;
  if (nonce[0] === 0) nonce[0] = 1;
  return nonce;
}

/** `TimeStampReq`, RFC 3161 §2.4.1, asking for the TSA's certificate back. */
export function buildTimestampRequest(request: TimestampRequest): Uint8Array {
  if (request.digest.length !== 32) throw new Error("A SHA-256 digest is 32 bytes.");

  return sequence(
    integer(1),
    sequence(
      sequence(oid(OID_SHA256), nullValue()),
      encode(0x04, request.digest),
    ),
    integer(request.nonce),
    // certReq: without the certificate the token cannot be checked offline.
    encode(0x01, Uint8Array.of(0xff)),
  );
}

export type TimestampResponse =
  | { granted: true; token: Uint8Array }
  | { granted: false; status: number; reason: string };

const STATUS_TEXT: Record<number, string> = {
  0: "granted",
  1: "granted with modifications",
  2: "rejected",
  3: "waiting",
  4: "revocation warning",
  5: "revocation notification",
};

/** `TimeStampResp`, RFC 3161 §2.4.2: a status and, when granted, the token. */
export function parseTimestampResponse(bytes: Uint8Array): TimestampResponse {
  const [statusInfo, token] = readChildren(readNode(bytes));
  const [status] = readChildren(statusInfo);
  const code = readInteger(status);

  if (code !== 0 && code !== 1) {
    return {
      granted: false,
      status: code,
      reason: `The time-stamp authority answered “${STATUS_TEXT[code] ?? code}”.`,
    };
  }
  if (!token) {
    return { granted: false, status: code, reason: "The answer carried no time-stamp token." };
  }
  return { granted: true, token: token.full };
}

export type TimestampToken = {
  genTime: Date;
  /** OID of the hash the TSA stamped. */
  imprintAlgorithm: string;
  imprint: Uint8Array;
  nonce?: Uint8Array;
  /** The time-stamp policy the TSA says it followed. */
  policy: string;
  /** Subject of the certificate the token carries, when it carries one. */
  tsa?: string;
};

/** The `TSTInfo` inside a time-stamp token (a CMS `SignedData`). */
export function readTimestampToken(token: Uint8Array): TimestampToken {
  const contentInfo = readChildren(readNode(token));
  if (readOid(contentInfo[0].content) !== OID_SIGNED_DATA) {
    throw new Error("The time-stamp token is not a CMS SignedData.");
  }

  const signedData = readChildren(readChildren(contentInfo[1])[0]);
  // version, digestAlgorithms, encapContentInfo, [0] certificates, [1] crls, signerInfos
  const encapsulated = readChildren(signedData[2]);
  if (readOid(encapsulated[0].content) !== OID_TST_INFO) {
    throw new Error("The token does not contain TSTInfo.");
  }

  const octets = readChildren(encapsulated[1])[0];
  const info = readChildren(readNode(octets.content));
  // version, policy, messageImprint, serialNumber, genTime, [accuracy], [ordering], [nonce], [tsa], …
  const [, policy, imprint, , genTime] = info;
  const [algorithm, hashed] = readChildren(imprint);

  let nonce: Uint8Array | undefined;
  for (const field of info.slice(5)) {
    // The nonce is the only INTEGER after genTime; accuracy is a SEQUENCE.
    if (field.tag === 0x02) nonce = field.content;
  }

  const certificates = signedData.find((node) => node.tag === 0xa0);
  let tsa: string | undefined;
  if (certificates) {
    try {
      tsa = readCertificate(readChildren(certificates)[0].full).subject;
    } catch {
      // A certificate this reader cannot parse is not worth failing the token over.
    }
  }

  return {
    genTime: parseGeneralizedTime(new TextDecoder().decode(genTime.content)),
    imprintAlgorithm: readOid(readChildren(algorithm)[0].content),
    imprint: hashed.content,
    nonce: nonce ? stripLeadingZeros(nonce) : undefined,
    policy: readOid(policy.content),
    tsa,
  };
}

export type TimestampCheck =
  | { valid: true; token: TimestampToken }
  | { valid: false; problems: string[]; token?: TimestampToken };

/**
 * Does this token stamp exactly `expected`? (and, if given, answer this nonce)
 *
 * A token that stamps *something else* is the interesting failure: it is a
 * perfectly good token, signed by a perfectly good TSA, attached to a signature
 * it says nothing about.
 */
export function checkTimestampToken(
  tokenBytes: Uint8Array,
  expected: { digest: Uint8Array; nonce?: Uint8Array },
): TimestampCheck {
  let token: TimestampToken;
  try {
    token = readTimestampToken(tokenBytes);
  } catch (error) {
    return {
      valid: false,
      problems: [error instanceof Error ? error.message : "The time-stamp token could not be read."],
    };
  }

  const problems: string[] = [];
  if (token.imprintAlgorithm !== OID_SHA256) {
    problems.push("The time-stamp covers a hash other than SHA-256.");
  } else if (!equal(token.imprint, expected.digest)) {
    problems.push("The time-stamp covers a different signature value than this one.");
  }
  if (expected.nonce && (!token.nonce || !equal(token.nonce, stripLeadingZeros(expected.nonce)))) {
    problems.push("The time-stamp answers a different request (nonce mismatch).");
  }

  return problems.length === 0 ? { valid: true, token } : { valid: false, problems, token };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readInteger(node: DerNode): number {
  let value = 0;
  for (const byte of node.content) value = value * 256 + byte;
  return value;
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** `YYYYMMDDHHMMSS[.fff]Z` */
function parseGeneralizedTime(text: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(text);
  if (!match) throw new Error(`Unreadable time-stamp time “${text}”.`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0,
    ),
  );
}
