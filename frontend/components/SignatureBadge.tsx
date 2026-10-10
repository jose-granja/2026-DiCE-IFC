"use client";

import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";

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

  return (
    <div className={cn("space-y-0.5", className)}>
      <p
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
      </p>

      {signer && (
        <p className="text-muted-foreground truncate text-[11px]" title={signer.subject}>
          {commonName(signer.subject)}
          {signer.signingTime ? ` · ${signer.signingTime.slice(0, 10)}` : ""}
        </p>
      )}

      {signature.valid && signer?.trust === "not-checked" && (
        <p className="text-muted-foreground flex items-start gap-1 text-[11px]">
          <ShieldQuestion className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {/* Integrity is not trust, and both halves of this sentence have to
              be said. The second was once commented out, leaving the badge
              asserting that content is unchanged and silent on whether the
              certificate means anything — which is the most damaging thing it
              could do. `e2e/ifczip.spec.ts` asserts the caveat is on screen. */}
          {t("trustCaveat")}
        </p>
      )}

      {signature.problems.map((problem) => (
        <p key={problem} className="text-destructive text-[11px]">
          {problem}
        </p>
      ))}
    </div>
  );
}

export default SignatureBadge;
