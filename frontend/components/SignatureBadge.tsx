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

  const [signer] = signature.signers;

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
        ? t("signatureValid", { count: signature.signers.length })
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

      {signer && (
        <p className="text-muted-foreground truncate text-[11px]" title={signer.subject}>
          {commonName(signer.subject)}
          {signer.signingTime ? ` · ${signer.signingTime.slice(0, 10)}` : ""}
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
