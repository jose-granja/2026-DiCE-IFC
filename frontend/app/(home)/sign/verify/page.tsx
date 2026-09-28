"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  ShieldQuestion,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import ModuleHeader from "@/components/ModuleHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { verifyContainer, type ContainerVerification } from "@/lib/signing/verify";

/**
 * Offline verification.
 *
 * Everything here happens in the browser: the container is re-hashed and the
 * signature is checked against the certificate it carries. Nothing is uploaded.
 *
 * The page is careful about what it claims. A valid signature proves the bytes
 * are the ones that were signed and that the signer held the key for the
 * enclosed certificate. It does **not** prove the certificate is a genuine
 * Portuguese qualified certificate, or that it was not revoked — those need the
 * trusted list and OCSP, which a browser cannot fetch. Until the `trust/` proxy
 * exists, that gap is stated on screen rather than glossed over.
 */
export default function SignVerifyPage() {
  const t = useTranslations("signVerify");
  const [result, setResult] = useState<ContainerVerification | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setResult(await verifyContainer(bytes));
      setFileName(file.name);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("fileCouldNotBeRead"),
      );
    } finally {
      setBusy(false);
    }
  };

  const verdict = result
    ? result.signatures.length > 0 && result.signatures.every((s) => s.valid)
    : null;

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col overflow-auto">
      <ModuleHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="ghost" size="sm" asChild disabled={busy}>
            <label>
              <Upload className="h-4 w-4" />
              {busy ? t("checking") : t("openContainer")}
              <input
                type="file"
                accept=".ifczip,.bcf,.bcfzip,.asice,.zip,.scs"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) await onFile(file);
                }}
              />
            </label>
          </Button>
        }
      />

      <div className="max-w-full space-y-4 p-4">
        {!result && (
          <div className="text-muted-foreground rounded-md border border-dashed p-10 text-center text-sm">
            <p className="font-medium">{t("noContainerOpened")}</p>
            <p className="mt-1 text-xs">
              {t.rich("openSignedHint", { code: (chunks) => <code>{chunks}</code> })}
            </p>
          </div>
        )}

        {result && (
          <>
            <div
              className={
                verdict
                  ? "flex items-center gap-2 rounded-md border border-emerald-600/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
                  : "border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
              }
              role="status"
            >
              {verdict ? (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              ) : (
                <XCircle className="h-4 w-4" aria-hidden />
              )}
              {verdict
                ? t("signatureValid")
                : t("signatureNotValid")}
              {fileName && (
                <span className="text-muted-foreground font-normal">· {fileName}</span>
              )}
            </div>

            {result.problems.length > 0 && (
              <ul className="space-y-1">
                {result.problems.map((problem) => (
                  <li
                    key={problem}
                    className="flex items-start gap-2 rounded-md border p-2.5 text-xs"
                  >
                    <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {problem}
                  </li>
                ))}
              </ul>
            )}

            {verdict && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-300 hidden">
                <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  {t.rich("notATrustDecision", { strong: (chunks) => <strong>{chunks}</strong> })}
                </span>
              </p>
            )}

            {result.payload.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold">{t("contents")}</h2>
                <ul className="text-muted-foreground space-y-0.5 text-xs">
                  {result.payload.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </section>
            )}

            {result.signatures.map((signature) => (
              <section key={signature.file} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xs font-semibold">{signature.file}</h2>
                  <Badge
                    variant={signature.valid ? "default" : "destructive"}
                    className="h-4 px-1.5 text-[10px]"
                  >
                    {signature.valid ? t("valid") : t("invalid")}
                  </Badge>
                  {signature.algorithm && (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      {signature.algorithm}
                    </Badge>
                  )}
                </div>

                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <Row label={t("signedBy")} value={signature.subject} />
                  <Row label={t("issuedBy")} value={signature.issuer} />
                  <Row label={t("serial")} value={signature.serial} />
                  <Row label={t("signingTime")} value={signature.signingTime ?? "—"} />
                  <Row
                    label={t("certificateValid")}
                    value={t("certificateValidRange", {
                      from: signature.notBefore.slice(0, 10),
                      to: signature.notAfter.slice(0, 10),
                    })}
                  />
                  <Row
                    label={t("signatureMaths")}
                    value={signature.signatureValid ? t("verified") : t("failed")}
                  />
                </dl>

                <div className="space-y-1">
                  <h3 className="text-[11px] font-medium">{t("whatItCovers")}</h3>
                  <ul className="space-y-0.5">
                    {signature.references.map((reference) => (
                      <li
                        key={reference.uri}
                        className="flex items-center gap-1.5 text-[11px]"
                      >
                        {reference.present && reference.digestMatches ? (
                          <CheckCircle2
                            className="h-3 w-3 shrink-0 text-emerald-600"
                            aria-hidden
                          />
                        ) : (
                          <AlertTriangle
                            className="text-destructive h-3 w-3 shrink-0"
                            aria-hidden
                          />
                        )}
                        <span className="truncate">
                          {reference.uri.startsWith("#")
                            ? t("signedProperties")
                            : reference.uri}
                        </span>
                        {!reference.present && (
                          <span className="text-destructive">{t("notInContainer")}</span>
                        )}
                        {reference.present && !reference.digestMatches && (
                          <span className="text-destructive">{t("contentChanged")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {signature.problems.length > 0 && (
                  <ul className="text-destructive space-y-0.5 text-[11px]">
                    {signature.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground shrink-0">{label}:</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
