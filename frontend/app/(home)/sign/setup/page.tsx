"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  HelpCircle,
  RefreshCw,
} from "lucide-react";

import ModuleHeader from "@/components/ModuleHeader";
import { Button } from "@/components/ui/button";
import {
  availableDownloads,
  detectArchitecture,
  detectPlatform,
  type CompanionDownload,
} from "@/lib/signing/companion-download";
import { registerSigningProviders } from "@/lib/signing/register";
import {
  defaultSigningProviderId,
  getSigningProvider,
  type ReadinessCheck,
  type ReadinessReport,
} from "@/lib/signing/provider";

/**
 * The signing setup checklist.
 *
 * Most of this module's support burden lands here, so it is written to be read
 * by someone whose signing "just failed" — every red row says what is missing
 * and links to the thing that fixes it.
 *
 * It is deliberately honest about the current state: Portuguese card support
 * needs a Web eID build that recognises the Cartão de Cidadão, and that build
 * does not exist yet (ADR 004). Showing a hopeful green here would send people
 * to the PIN dialog that never appears.
 */
export default function SignSetupPage() {
  const t = useTranslations("signSetup");
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [download, setDownload] = useState<CompanionDownload | null>(null);
  const [others, setOthers] = useState<CompanionDownload[]>([]);

  // The effect must not touch state before its first await, or it is just a
  // render-time setState wearing a disguise — which is what
  // react-hooks/set-state-in-effect exists to catch. `cancelled` covers the
  // unmount-before-resolve case; the handshake has a two-second timeout.
  useEffect(() => {
    let cancelled = false;

    // Readiness pairs with the companion as a side effect, so by the time this
    // resolves there is nothing left for the citizen to configure.
    Promise.all([readiness(t("noProviderLabel"), t("noProviderRemedy")), detectArchitecture()]).then(
      async ([next, architecture]) => {
        const platform = detectPlatform(architecture);
        const found = await availableDownloads(platform);
        if (cancelled) return;
        setDownload(found.download);
        setOthers(found.others);
        setReport(next);
        setChecking(false);
      },
    );

    return () => {
      cancelled = true;
    };
    // `t` must not be a dependency — this is a mount-once pairing handshake,
    // and a locale change must not re-pair with the companion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The button is an event handler, so setting state up front is fine here.
  const check = async () => {
    setChecking(true);
    setReport(await readiness(t("noProviderLabel"), t("noProviderRemedy")));
    setChecking(false);
  };

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col overflow-auto">
      <ModuleHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="ghost" size="sm" onClick={check} disabled={checking}>
            <RefreshCw className="h-4 w-4" />
            {checking ? t("checking") : t("checkAgain")}
          </Button>
        }
      />

      <div className="max-w-3xl m-auto space-y-4 p-4">
        <section className="space-y-2 rounded-md border p-3">
          <h2 className="text-sm font-semibold">{t("cmdNotSupportedTitle")}</h2>
          <p className="text-muted-foreground text-xs">
            {t.rich("cmdNotSupportedBody", { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <a
            className="text-primary inline-flex items-center gap-1 text-xs underline underline-offset-2"
            href="https://www.autenticacao.gov.pt/cc-aplicacao"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("autenticacaoGovLink")}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("onThisMachine")}</h2>
          {report ? (
            <ul className="space-y-2">
              {report.checks.map((item) => (
                <CheckRow key={item.id} check={item} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">{t("checking")}</p>
          )}
        </section>

        <section className="space-y-3 rounded-md border p-3">
          <div>
            <h2 className="text-sm font-semibold">{t("signingCompanionTitle")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("signingCompanionBody")}
            </p>
          </div>

          {download ? (
            <div className="space-y-2">
              <Button asChild size="sm" className="h-8">
                <a href={download.href} download>
                  <Download className="h-4 w-4" />
                  {t(`download.${download.platform}`)}
                </a>
              </Button>
              <p className="text-muted-foreground text-[11px]" data-companion-warning>
                {t(
                  download.platform === "windows"
                    ? `warning.windows.${download.kind}`
                    : "warning.macos",
                )}
              </p>

              {others.length > 0 && (
                <p className="text-muted-foreground text-[11px]">
                  {t("differentMachine")}{" "}
                  {others.map((entry, index) => (
                    <span key={entry.platform}>
                      {index > 0 && " · "}
                      <a className="underline underline-offset-2" href={entry.href} download>
                        {t(`platform.${entry.platform}`)}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {t.rich("noInstallerPublished", { code: (chunks) => <code>{chunks}</code> })}
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="ghost" className="h-8" onClick={check}>
              <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
              {t("checkAgain")}
            </Button>
            {report?.ready && (
              <span className="text-[11px] text-emerald-500">{t("pairedAndReady")}</span>
            )}
          </div>

          <p className="text-muted-foreground text-[11px]">
            {t("companionDigestOnly")}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("whatEachPieceDoes")}</h2>
          <dl className="text-muted-foreground space-y-2 text-xs">
            <div>
              <dt className="text-foreground font-medium">{t("cardReaderTitle")}</dt>
              <dd>
                {t("cardReaderBody")}
              </dd>
            </div>
            <div>
              <dt className="text-foreground font-medium">
                {t("middlewareTitle")}
              </dt>
              <dd>
                {t.rich("middlewareBody", { code: (chunks) => <code>{chunks}</code> })}
              </dd>
            </div>
            <div>
              <dt className="text-foreground font-medium">
                {t("extensionTitle")}
              </dt>
              <dd>
                {t("extensionBody")}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

/**
 * Ask the configured provider whether it can sign, never throwing.
 *
 * A missing extension is the ordinary state of a fresh machine — the thing this
 * page exists to explain — not an exception.
 */
async function readiness(
  noProviderLabel: string,
  noProviderRemedy: string,
): Promise<ReadinessReport> {
  try {
    registerSigningProviders();
    const provider = await getSigningProvider();
    return await provider.getReadiness();
  } catch {
    return {
      providerId: defaultSigningProviderId(),
      ready: false,
      checks: [
        {
          id: "extension",
          label: noProviderLabel,
          status: "missing",
          remedy: noProviderRemedy,
        },
      ],
    };
  }
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const t = useTranslations("signSetup");
  const Icon =
    check.status === "ok"
      ? CheckCircle2
      : check.status === "missing"
        ? AlertCircle
        : HelpCircle;

  return (
    <li
      className="flex items-start gap-2 rounded-md border p-2.5"
      // Read by e2e: asserting on the label alone proves only that the row was
      // rendered, which it always is.
      data-check={check.id}
      data-status={check.status}
    >
      <Icon
        className={
          check.status === "ok"
            ? "mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
            : check.status === "missing"
              ? "text-destructive mt-0.5 h-4 w-4 shrink-0"
              : "text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
        }
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">
          {check.labelKey ? t(`checks.${check.labelKey}.label`, check.values) : check.label}
          <span className="sr-only">
            {check.status === "ok"
              ? t("statusPresent")
              : check.status === "missing"
                ? t("statusMissing")
                : t("statusUnknown")}
          </span>
        </p>
        {check.remedy && (
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {check.remedyKey ? t(`checks.${check.remedyKey}.remedy`, check.values) : check.remedy}
          </p>
        )}
        {check.href && (
          <a
            className="text-primary mt-0.5 inline-flex items-center gap-1 text-[11px] underline underline-offset-2"
            href={check.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("getIt")}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
    </li>
  );
}
