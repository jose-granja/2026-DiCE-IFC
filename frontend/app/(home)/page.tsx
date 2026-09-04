import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";

import { MODULES } from "@/config";
import LocalOnlyBadge from "@/components/LocalOnlyBadge";
import MaxWidthWrapper from "@/components/MaxWidthWrapper";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage() {
  // `useTranslations` works in a Server Component: next-intl resolves messages
  // synchronously from the request config, so this page stays static-rendered.
  const t = useTranslations();

  return (
    <MaxWidthWrapper className="py-12">
      <div className="flex flex-col gap-3">
        <LocalOnlyBadge className="self-start" />
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("app.tagline")}
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {t("app.description")}{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            {t("app.seeWhatLeaves")}
          </Link>
          .
        </p>
      </div>

      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map((m) => (
          <li key={m.href}>
            <Link href={m.href} className="group block h-full">
              <Card className="hover:border-primary/40 h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    {t(`modules.${m.key}.title`)}
                    <ArrowRight className="text-muted-foreground group-hover:text-primary h-4 w-4 transition-colors" />
                  </CardTitle>
                  <CardDescription>{t(`modules.${m.key}.description`)}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </MaxWidthWrapper>
  );
}
