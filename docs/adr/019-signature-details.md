# ADR 019 — Reason, place and professional attributes in a signature

- **Status:** **Reason and place: accepted, built.** **Professional attributes (SCAP): proposed** — the place in the signature, the interface and a switched-off control are built; nothing talks to SCAP, because this application is not registered with AMA.
- **Date:** 2026-11-22
- **Related:** ADR 002 (IFCZIP container), ADR 007 (companion), ADR 011 (signatures inside the IFC), ADR 012 (time-stamps)

## Context

The Autenticação.gov application, signing a PDF, offers three things beside
the signature: a **Motivo** (free text), a **Localização** (free text) and
**atributos profissionais** — a role such as "Engenheiro civil", certified by
the professional order through AMA's SCAP (Sistema de Certificação de
Atributos Profissionais). People who sign models here asked for the same.

A PDF has a place for each: `/Reason` and `/Location` in the signature
dictionary. The formats signed here do not:

- **XAdES** (IFCZIP, BCF; ETSI EN 319 132-1) has `SignatureProductionPlaceV2`
  (City, StreetAddress, StateOrProvince, PostalCode, CountryName) for the
  place, and `SignerRoleV2` (claimed roles, certified roles, signed assertions)
  for attributes. It has **no free-text reason.** The nearest is
  `CommitmentTypeIndication`, whose identifier is required and names a
  commitment such as proof of approval or proof of creation.
- **CMS/CAdES** (inside an IFC; RFC 5126, EN 319 122-1) has the same three:
  `signer-location` (1.2.840.113549.1.9.16.2.17), `commitment-type-indication`
  (…2.16), whose identifier is an OID, and `signer-attributes-v2`.

The person asked for the reason as **free text only**, like the PDF dialog,
and not a choice of standard commitment types.

## Decision

### 1. The place is the standard place

`SignatureProductionPlaceV2/City` in XAdES; `signer-location` → `localityName`
in CMS, as a UTF8String under RFC 5126's explicit tags. One free-text field,
as in the PDF dialog, goes in the locality. Reading, the verifier accepts any
tool's place (V1 or V2, every part, joined) and a PrintableString or
IA5String locality.

### 2. The reason is a commitment type of our own, with the text as its qualifier

A commitment needs an identifier, and none of ETSI's means "a free-text
reason" — using proof of approval would put words in the signer's mouth. So the
reason carries this application's own identifier, minted under the X.667 UUID
arc, which needs no registration:

`2.25.6728704243302675995283675829038684891` (UUID `050fe6bb-867f-439b-a329-7bcb9cc31adb`)

It means "the reason the signer typed, in the qualifier" and nothing else. In
XAdES it is `urn:oid:…` with `Qualifier="OIDAsURN"`, covering
`AllSignedDataObjects`, the text in `CommitmentTypeQualifier`; in CMS the same
OID, with one qualifier of the same OID whose value is a UTF8String.

A validator that lists commitment types (EU DSS does) shows the identifier
and, for XAdES, the `Description` "Reason stated by the signer". Only this
application's verifier shows the text itself. That is the price of free text
in a format without it; a standard commitment type would be read everywhere,
and remains possible as an addition if anyone asks.

`der.ts` read and wrote OID arcs as JS numbers, which would silently round a
128-bit arc into a different OID. Both now use BigInt.

### 3. Signed, and read back only from what was signed

Both go inside what the card signs: XAdES `SignedProperties`, CMS signed
attributes. Changing one afterwards breaks the signature. The XAdES verifier
reads them **only** from a `SignedProperties` a Reference covers with a
matching digest, so an element added outside the signed part never shows.

Reading them is for display and never decides validity: an encoding the
reader does not know is left out, not failed.

Text is cleaned before signing: one line, control characters and runs of
whitespace become a space, at most 200 characters. Empty adds nothing.

The page says what they are: the signer's statement, which nobody checked. A
place is wherever the signer says they were.

### 4. What crosses to the companion

- **IFCZIP and BCF: nothing new.** The details sit in `SignedProperties`; only
  its digest is in `SignedInfo`, which is all the companion is sent.
- **Inside an IFC: the text, to the local companion only.** The companion is
  sent the CMS signed attributes in full (the card hashes internally, so a
  digest alone does not work; ADR 011), and the reason and place are now among
  them, up to 200 characters each. It is the signer's own statement, typed to
  be signed, not model content; it goes to a program on the same machine
  (AGENTS.md §1's boundary), which does not log it, and stays well within its
  8 KiB body limit. Nothing reaches the network.

### 5. Professional attributes: the shape, switched off (proposed)

What is built:

- `lib/signing/professional-attributes.ts`: a `ProfessionalAttributeSource`
  (`availability()`, `attributesFor(certificate)`), and `scap`, which answers
  `not-configured`.
- The slot: XAdES `SignerRoleV2/SignedAssertions/SignedAssertion`, holding the
  issuer's assertion **base64, as received** — never parsed and rebuilt, since
  the issuer signed those bytes. The verifier counts them and says they were
  not checked.
- On `/sign/ifc` and `/sign/bcf`, the option is shown disabled, saying why.

What turning it on needs, and what is not known yet:

1. **Registration with AMA.** SCAP answers applications AMA has registered.
   This application is not, and AGENTS.md §6 rules out an AMA ApplicationId
   for Chave Móvel Digital; accepting this ADR would revise that rule for SCAP
   alone.
2. **The citizen authenticates with the card** before SCAP releases their
   attributes — in the Autenticação.gov app, with the authentication
   certificate, which is a second PIN. The protocol is AMA's and has to be read
   from their documentation once registered; nothing here assumes it.
3. **Who talks to SCAP.** Card authentication needs the companion, which
   would then do more than sign ("a device, not a signing service"); the
   application's own AMA credentials cannot be in the browser, so they need a
   route handler like `/api/tsa`. Both widen AGENTS.md §1's tables, and need
   writing down there before code.
4. **Embedded IFC.** CAdES `signer-attributes-v2` has `signedAssertions`, each
   with an OID naming the assertion's type. Which one fits SCAP's format is
   unknown until that format is, so the embedded format carries no attributes
   yet; a batch asking for them on an `.ifc` is refused rather than signed
   without them.
5. **Verifying an attribute** means checking the issuer's signature and trust
   in the issuer — the same gap as the certificate's trust (`trust:
   "not-checked"`). Until then it is shown as present and not checked.

## Consequences

- A reviewer can say why they signed ("Revisão e aprovação") and where, in
  both formats, and a co-signature carries its own.
- Other validators show the place, and the reason's identifier but not its
  text; this application shows both. Worth saying to anyone comparing.
- Professional attributes stay visibly unavailable until a registration
  exists. The code they need on this side is small; the decisions in §5 are
  not.
