/**
 * What a signer states about a signature, signed with it: the reason
 * ("Motivo"), the place ("Localização") and, once ADR 019 is accepted,
 * certified professional attributes.
 *
 * All three go inside the part of the signature the card signs — XAdES
 * `SignedProperties` for an IFCZIP or BCF, CMS signed attributes inside an IFC —
 * so changing one afterwards breaks the signature like changing the model does.
 *
 * Where each one goes, in standard places (ETSI EN 319 132-1, EN 319 122-1):
 *
 * | | XAdES | CMS |
 * |---|---|---|
 * | place  | `SignatureProductionPlaceV2/City` | `signer-location` → `localityName` |
 * | reason | `CommitmentTypeIndication`, its qualifier the text | `commitment-type-indication`, its qualifier the text |
 * | professional attributes | `SignerRoleV2/SignedAssertions` | — (not yet) |
 *
 * Neither format has a free-text "reason" like a PDF's. The standard place is a
 * commitment type, which needs an identifier; `REASON_COMMITMENT_OID` is this
 * application's, minted under the X.667 UUID arc (`2.25`), which needs no
 * registration. It means "the reason the signer typed, in the qualifier" and
 * nothing else — not approval, not authorship. Validators that list commitment
 * types show the identifier; this application's verifier shows the text.
 *
 * What is stated is **the signer's statement**, not a fact anyone checked. A
 * place is wherever the signer says they were.
 */

/** The longest reason or place kept. A sentence, not a document. */
export const DETAIL_MAX_LENGTH = 200;

/** "Free-text reason, stated by the signer": 2.25 + UUID 050fe6bb-867f-439b-a329-7bcb9cc31adb. */
export const REASON_COMMITMENT_OID = "2.25.6728704243302675995283675829038684891";

/**
 * A professional attribute certified by its issuer — in Portugal, a
 * professional order through AMA's SCAP — as the issuer's own signed
 * assertion. Off until ADR 019 is accepted: see `professional-attributes.ts`.
 */
export type CertifiedAttribute = {
  /** "Engenheiro civil", as the issuer words it. For display before signing. */
  description: string;
  /** "Ordem dos Engenheiros". */
  issuer: string;
  /** The issuer's signed assertion, base64, exactly as received. Never rebuilt. */
  assertion: string;
};

export type SignatureDetails = {
  reason?: string;
  location?: string;
  /** XAdES only (IFCZIP, BCF). */
  professionalAttributes?: CertifiedAttribute[];
};

/** What a verifier read back. Professional attributes are counted, not read: their format is SCAP's. */
export type StatedDetails = {
  reason?: string;
  location?: string;
  /** Certified attributes carried, unchecked. Absent when none. */
  certifiedAttributes?: number;
};

/**
 * One line of plain text: control characters and runs of whitespace become a
 * space, the ends are trimmed, and the length is capped. Empty becomes
 * `undefined`, so an empty field adds nothing to the signature.
 */
export function cleanDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return cleaned ? Array.from(cleaned).slice(0, DETAIL_MAX_LENGTH).join("") : undefined;
}

/** The details worth signing, or `undefined` when there are none. */
export function cleanDetails(details: SignatureDetails | undefined): SignatureDetails | undefined {
  if (!details) return undefined;
  const reason = cleanDetail(details.reason);
  const location = cleanDetail(details.location);
  const professionalAttributes = details.professionalAttributes?.length ? details.professionalAttributes : undefined;
  if (!reason && !location && !professionalAttributes) return undefined;
  return {
    ...(reason ? { reason } : {}),
    ...(location ? { location } : {}),
    ...(professionalAttributes ? { professionalAttributes } : {}),
  };
}

/** `undefined` when nothing was stated, so a caller can spread it. */
export function statedOrNothing(details: StatedDetails): StatedDetails | undefined {
  return details.reason || details.location || details.certifiedAttributes ? details : undefined;
}
