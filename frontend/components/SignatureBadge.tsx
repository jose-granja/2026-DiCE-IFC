"use client";

import { useTranslations } from "next-intl";
import { Info, Loader2, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

  const caveat = signature.valid && signer?.trust === "not-checked";

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
      {caveat && <Info className="h-3 w-3 shrink-0 opacity-70" aria-hidden />}
    </span>
  );

  return (
    <div className={cn("space-y-0.5", className)}>
      {caveat ? (
        /*
          Integrity is not trust, and the sentence that says so has to stay one
          press away from "valid" — it was once commented out, leaving the badge
          asserting that content is unchanged and silent on whether the
          certificate means anything, which is the most damaging thing it could
          do. It is in a popover rather than on the row because the same
          sentence under every model was noise; the info icon on the status says
          there is something to read, and `e2e/ifczip.spec.ts` asserts it opens.
        */
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="focus-visible:ring-ring/50 -mx-1 rounded px-1 text-left hover:underline focus-visible:ring-2 focus-visible:outline-none"
              aria-label={t("signatureDetails")}
              data-signature-status
            >
              {status}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3 text-xs" data-signature-caveat>
            <p className="flex items-start gap-2">
              <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {t(signature.format === "embedded" ? "embeddedTrustCaveat" : "trustCaveat")}
              </span>
            </p>
          </PopoverContent>
        </Popover>
      ) : (
        <p data-signature-status>{status}</p>
      )}

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
