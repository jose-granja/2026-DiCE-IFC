# ADR 011 — Embedded IFC signatures alongside IFCZIP

- **Status:** Accepted; **amended 2026-11-22** for co-signing and for a signature time-stamp (CAdES-T)
- **Date:** 2026-10-12

## Context

The user wants one signed `.ifc` file, using the existing local Cartão de
Cidadão companion, while retaining the IFCZIP signing page. ADR 002's ASiC-E
decision remains in force for `/sign/ifc` and `/sign/bcf`.

buildingSMART publishes a [comment-based IFC signature verifier](https://github.com/buildingSMART/validate/blob/main/backend/apps/ifc_validation/checks/signatures/check_signatures.py).
It accepts base64 DER CMS SignedData in a `/* SIGNATURE; … ENDSEC; */` suffix.
The signed content is the preceding file after removing control characters
(codes below 0x20 and DEL); ordinary spaces remain significant. Its reader
requires ASCII. This differs from signing the entire file byte for byte.

## Decision

- Add `/sign/ifc-embedded`, independently of the existing ASiC-E/XAdES pages.
  It signs one plain ASCII STEP IFC, or verifies embedded signatures offline.
  Unicode expressed with STEP escapes is supported; raw UTF-8 is refused,
  with a link to the existing IFCZIP flow. The original bytes are preserved.
- Append detached [CMS SignedData (RFC 5652)](https://www.rfc-editor.org/rfc/rfc5652)
  with SHA-256 and either RSA PKCS#1 v1.5 or ECDSA P-256, selected from the
  signing certificate. CMS signed attributes include contentType,
  messageDigest, signingTime and SigningCertificateV2 (SHA-256 certificate
  binding). The P1363 ECDSA value from PKCS#11 is converted to DER for CMS.
- Reuse the current companion protocol and its CITIZEN SIGNATURE key. Only
  digest-bearing signed attributes and the certificate reach localhost.
  ADR 007's amended protocol already accepts signature metadata bytes because
  the RSA middleware hashes internally. No file, PIN, new endpoint or network
  origin is introduced. XML c14n applies to XAdES; CMS uses DER, and the IFC
  uses the explicit buildingSMART normalization described above.
- A worker reads, normalizes, hashes, verifies and assembles the IFC. Verify
  the returned signature with the certificate before offering a download.
  Check the echoed certificate and algorithm; never retry a PIN operation
  automatically. Parse STEP strings and comments before identifying signatures.
- Refuse to sign an already signed IFC. Verification handles up to 16
  consecutive signature comments, each covering the preceding normalized
  content. Reject any unsigned suffix after the final comment. Signature
  removal cannot be detected without an external record of expected signers.
- Verification supports detached SHA-256 CMS with one issuer/serial signer
  per block and signed attributes, with RSA or P-256 keys. Other profiles
  fail closed. Certificate chain, expiry, revocation, qualified status and
  timestamp trust are not checked; declared signing time is not a timestamp.
  The UI states those limits and the normalization rule.

## Compatibility and verification

The result stays `.ifc`; tools that understand STEP comments can read it.
Signature verification requires a tool that implements this format. The
Autenticação.gov PDF/ASiC validator is not a verifier for embedded IFC. This
format's interoperability does not establish qualified status or legal effect.

Tests use real RSA and P-256 keys, OpenSSL verification of generated CMS,
independent OpenSSL-produced CMS, tampered files, wrong returned certificates,
malformed framing and a browser flow through the companion's HTTP contract.
A physical card and PIN are still required for a hardware end-to-end check.

## Privacy review

- No model payload in a request, Server Action or URL.
- No new origin or network endpoint.
- Client page includes the shared local-processing badge.
- Companion receives only signature metadata; file processing stays local.
- Existing IFCZIP and BCF signing and verification paths remain available.

## Amendment — unified signing and verification

`/sign/ifc` now offers both IFCZIP and embedded IFC output. The former
`/sign/ifc-embedded` route redirects there so bookmarks continue to work.
Both formats accept multiple files: IFCZIP offers one shared signature or
separate containers; embedded IFC always signs each file independently and
serializes card operations. A cancelled PIN or device error stops the remaining
batch while preserving completed outputs. File-specific embedded-format errors
skip that file. Duplicate input names are rejected and output-name collisions
are resolved before download. A ZIP download of multiple signed files is only
packaging; each extracted file retains its own signature.

`/sign/verify` verifies both embedded IFC and signature containers. The viewer
also checks embedded signatures when loading raw IFC files, with the same
integrity/trust distinction as its existing IFCZIP badge. BCF signing keeps its
container format and shares the signing pages' layout. The existing optional
IFCZIP/BCF timestamp functionality is preserved; embedded CMS timestamps are
outside this implementation.

## Amendment (2026-11-22) — co-signing an embedded IFC

Signing **new** files still refuses an already signed IFC. Co-signing was at
first a separate, explicit choice on `/sign/ifc`; it is now automatic — the
page reads each queued file and sends a signed one to `cosignEmbeddedIfc`
(`signIfcFiles` in `bulk.ts`), an unsigned one to `signEmbeddedIfc`: the new CMS block is appended after the last one and
covers the normalized file up to it — the model **and every earlier
signature** — which is the chain the verifier already read. Signatures are
therefore sequential, unlike IFCZIP's parallel ones, and the page says so.
The output keeps the input's name.

Before the card signs, every existing block must verify, the file must hold
fewer than 16, and the card's certificate (issuer and serial) must not already
be a signer. After, the worker verifies the whole chain, the new block
included, before the file is offered. The limitation above stands: removing
the last signatures cannot be detected without a record of who was expected
to sign.

## Amendment (2026-11-22) — a signature time-stamp (CAdES-T)

An embedded signature can now carry a time-stamp, as IFCZIP signatures have
since ADR 012 — the same option on the same page, from the same sources (the
Cartão de Cidadão service through the companion, or the deployment's
authority), and off until the user ticks it.

- **What it covers:** SHA-256 of the SignerInfo's `signature` value, exactly as
  stored — DER for ECDSA — which is what RFC 3161 Appendix A specifies for a
  signature time-stamp. `prepareCms(…).timestampDigest(result)` computes it,
  checking the card's result first so a stamp is never spent on a signature
  that would be refused.
- **Where it goes:** `unsignedAttrs` (`[1]`), one attribute,
  `id-aa-signatureTimeStampToken` (1.2.840.113549.1.9.16.2.14), holding the
  token as received. Unsigned on purpose: a time-stamp over a signature cannot
  be inside what the signature covers. The block is appended with it, so a
  later co-signature covers it like the rest of the block.
- **Verifying:** the profile still fails closed. A SignerInfo may now have
  seven fields, the seventh only `unsignedAttrs` holding exactly that one
  attribute with one token; anything else there is refused. The token is
  checked against the stored signature value; a mismatch is reported and the
  signature stays valid, as for XAdES. `/sign/verify` shows it for both
  formats.
- **Older copies of this application** read a stamped signature as invalid —
  their verifier allowed six fields only. Files signed without a time-stamp are
  unchanged, and that is the default.
- A stamp that cannot be had (the service's limit, a network failure) leaves
  the signature unstamped and says why; the PIN was typed and the signature is
  kept.

