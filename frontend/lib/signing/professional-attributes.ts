/**
 * Where certified professional attributes would come from: AMA's SCAP
 * (Sistema de Certificação de Atributos Profissionais), the service behind the
 * "atributos profissionais" in the Autenticação.gov app.
 *
 * **Off.** ADR 019 is proposed, not accepted. SCAP answers only applications
 * ARTE has registered, over the network, after the citizen authenticates with
 * the card — and this application is not registered, so nothing here talks to
 * it. The interface is what the signing page and `xades.ts` are written
 * against, so turning it on is a source, not a redesign.
 *
 * What it will not do, whatever the source: send a model, an issue or a
 * digest of either. An attribute is about the person, and is fetched before
 * anything is signed; the signature then carries it (`SignerRoleV2`).
 */

import type { CertifiedAttribute } from "./details";
import type { SigningCertificate } from "./provider";

export type AttributeSourceAvailability =
  | { available: true }
  /** `not-configured`: this deployment has no SCAP registration (ADR 019). */
  | { available: false; reason: "not-configured" };

export interface ProfessionalAttributeSource {
  readonly id: "scap";
  availability(): Promise<AttributeSourceAvailability>;
  /**
   * The certified attributes of the card's holder, for them to choose from.
   * The certificate says whose; authenticating them is the source's job.
   */
  attributesFor(certificate: SigningCertificate): Promise<CertifiedAttribute[]>;
}

export class ProfessionalAttributeError extends Error {
  constructor(readonly code: "not-configured") {
    super(code);
    this.name = "ProfessionalAttributeError";
  }
}

/** SCAP, as this deployment has it: not configured. */
export const scap: ProfessionalAttributeSource = {
  id: "scap",
  availability: async () => ({ available: false, reason: "not-configured" }),
  attributesFor: async () => {
    throw new ProfessionalAttributeError("not-configured");
  },
};
