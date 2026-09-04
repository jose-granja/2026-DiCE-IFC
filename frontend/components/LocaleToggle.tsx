"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";

import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/config";
import { setLocale } from "@/lib/actions/locale";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LocaleToggle() {
  const current = useLocale() as Locale;
  const t = useTranslations("nav");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const choose = (locale: Locale) => {
    startTransition(async () => {
      await setLocale(locale);
      // The locale lives in a cookie, and messages are resolved on the server,
      // so the tree has to be re-rendered rather than just re-run on the client.
      router.refresh();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" disabled={isPending} aria-label={t("language")}>
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onSelect={() => choose(locale)}
            aria-current={locale === current ? "true" : undefined}
            className={locale === current ? "font-medium" : undefined}
          >
            {LOCALE_LABELS[locale]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default LocaleToggle;
