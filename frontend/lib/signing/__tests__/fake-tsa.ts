/**
 * A stand-in time-stamp authority, for tests: it answers an RFC 3161 request the
 * way a real one is shaped, minus the signature a real one would put on it
 * (`readTimestampToken` does not check that, and says it does not).
 */

import { encode, integer, oid, readChildren, readNode, sequence, set } from "../der";

const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

const generalizedTime = (at: Date) =>
  encode(
    0x18,
    new TextEncoder().encode(
      `${at.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`,
    ),
  );

/** The `TimeStampResp` for `request`, stamping `at`, with the chosen status. */
export function fakeTimestampResponse(
  request: Uint8Array,
  options: { at?: Date; status?: number; imprintOverride?: Uint8Array; nonceOverride?: Uint8Array } = {},
): Uint8Array {
  const status = options.status ?? 0;
  const statusInfo = sequence(integer(status));
  if (status > 1) return sequence(statusInfo);

  const [, imprint, nonce] = readChildren(readNode(request));
  const [, digest] = readChildren(imprint);

  const tstInfo = sequence(
    integer(1),
    oid("1.2.3.4.5"),
    sequence(
      sequence(oid(OID_SHA256), encode(0x05, new Uint8Array())),
      encode(0x04, options.imprintOverride ?? digest.content),
    ),
    integer(4242),
    generalizedTime(options.at ?? new Date("2026-10-12T09:30:00Z")),
    options.nonceOverride ? integer(options.nonceOverride) : integer(nonce.content),
  );

  const signedData = sequence(
    integer(3),
    set(sequence(oid(OID_SHA256))),
    sequence(oid("1.2.840.113549.1.9.16.1.4"), encode(0xa0, encode(0x04, tstInfo))),
    set(),
  );
  const token = sequence(oid("1.2.840.113549.1.7.2"), encode(0xa0, signedData));

  return sequence(statusInfo, token);
}
