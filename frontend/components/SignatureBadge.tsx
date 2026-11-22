"use client";

import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, ShieldX } from "lucide-react";

import { commonName, type SignatureSummary } from "@/lib/signing/summary";
import { cn } from "@/lib/utils";

/**
 * What a container's signature says.
 *
 * Shared by the model list and the BCF panel, because ADR 002 gives an
 * `.ifczip` and a `.bcf` the same container and they deserve the same
 * words.
 *
 * Every signer is listed, in the file's order. With more than one, each is
 * marked valid or not, so a co-signed file shows whose signature failed.
 *
 * `undefined` renders nothing. An unsigned file is the ordinary case, and a
 * badge on every one of them would train people to ignore the row that matters.
 */
export function SignatureBadge({
  signature,
  className,
}: {
  signature: SignatureSummary | null | undefined;
  className?: string;
}) {
  const t = useTranslations("signatureBadge");
  const embeddedT = useTranslations("embeddedSign");
  if (signature === undefined) return null;

  if (signature === null) {
    return (
      <p
        className={cn(
          "text-muted-foreground flex items-center gap-1 text-[11px]",
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {t("checkingSignature")}
      </p>
    );
  }

  const { signers } = signature;
  const failed = signers.filter((signer) => !signer.valid).length;
  // One signer reads as before; several are each marked, so the row says *which*
  // signature failed rather than only that one did.
  const several = signers.length > 1;

  const status = (
    <span
      className={cn(
        "flex items-center gap-1 text-[11px] font-medium",
        signature.valid
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-destructive",
      )}
    >
      {signature.valid ? (
        <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <ShieldX className="h-3 w-3 shrink-0" aria-hidden />
      )}
      {signature.valid
        ? t("signatureValid", { count: signers.length })
        : several && failed > 0
          ? t("signaturesNotValid", { failed, count: signers.length })
          : t("signatureNotValid")}
    </span>
  );

  // What a "valid" here does and does not mean is stated once, on the About page
  // (`about.trust`), not repeated under every model. It is the integrity of the
  // content and the signer's key — not that the certificate is trusted or
  // qualified — and that is the meaning to keep when this row is reworded.
  return (
    <div className={cn("space-y-0.5", className)}>
      <p data-signature-status>{status}</p>

      {signers.length > 0 && (
        <ol className="space-y-0.5" data-signers>
          {signers.map((signer, index) => (
            <li
              // Two signatures can share a signer and time; the position is the identity.
              key={index}
              className={cn(
                "flex items-start gap-1 text-[11px]",
                signer.valid ? "text-muted-foreground" : "text-destructive",
              )}
              title={signer.subject}
              data-signer
              data-valid={signer.valid}
            >
              {several &&
                (signer.valid ? (
                  <ShieldCheck className="mt-px h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={t("signerValid")} />
                ) : (
                  <ShieldX className="mt-px h-3 w-3 shrink-0" aria-label={t("signerNotValid")} />
                ))}
              <span className="min-w-0">
                <span className="block truncate">
                  {commonName(signer.subject)}
                  {signer.signingTime ? ` · ${signer.signingTime.slice(0, 10)}` : ""}
                </span>
                {/* What the signer stated, signed with it: reason, then place. */}
                {(signer.details?.reason || signer.details?.location) && (
                  <span
                    className="text-muted-foreground block truncate"
                    title={[
                      signer.details.reason && `${t("reason")}: ${signer.details.reason}`,
                      signer.details.location && `${t("location")}: ${signer.details.location}`,
                    ].filter(Boolean).join("\n")}
                    data-signer-details
                  >
                    {[signer.details.reason, signer.details.location].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Inside an IFC each signature covers the ones before it (ADR 011), so
          the order is part of what was signed; in an IFCZIP they are parallel. */}
      {several && signature.format === "embedded" && (
        <p className="text-muted-foreground text-[11px]" data-signature-chain>
          {t("embeddedChain")}
        </p>
      )}

      {signature.problems.map((problem) => (
        <p key={problem} className="text-destructive text-[11px]">
          {problem}
        </p>
      ))}
      {signature.embeddedProblem && (
        <p className="text-destructive text-[11px]">
          {embeddedT(`errors.${signature.embeddedProblem}`)}
        </p>
      )}
    </div>
  );
}

export default SignatureBadge;
