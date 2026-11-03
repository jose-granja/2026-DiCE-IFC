import type { Metadata } from "next";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { PASS_COOKIE, humanCheckConfig, safeNext, verifyPass } from "@/lib/human-check/pass";
import { HumanCheck } from "./HumanCheck";

/**
 * The human check (ADR 013): where `proxy.ts` sends a visitor without a pass.
 *
 * Outside the `(home)` layout on purpose — its navigation would only lead back
 * here. The site key is read at request time, so it is a runtime setting like
 * the secret, not a `NEXT_PUBLIC_` value baked into the build.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("humanCheck");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

export default async function HumanCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next: requested } = await searchParams;
  const next = safeNext(typeof requested === "string" ? requested : null);
  const config = humanCheckConfig();
  // Nothing to check on this deployment, or already passed: straight on.
  if (!config) redirect(next);
  if (await verifyPass((await cookies()).get(PASS_COOKIE)?.value, config.secretKey)) redirect(next);

  const t = await getTranslations("humanCheck");
  const locale = await getLocale();

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="bg-card w-full max-w-md space-y-4 rounded-xl border p-6 shadow-sm" data-human-check>
        <div className="flex items-center gap-2">
          <Image src="/isise-logo.svg" alt="ISISE" width={28} height={28} />
          <span className="text-sm font-semibold">DiCE-IFC</span>
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">{t("intro")}</p>
        </div>
        <HumanCheck siteKey={config.siteKey} next={next} locale={locale} />
        <noscript>
          <p className="text-destructive text-sm">{t("noscript")}</p>
        </noscript>
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {t("privacy")}{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            {t("privacyLink")}
          </Link>
        </p>
      </div>
    </main>
  );
}
