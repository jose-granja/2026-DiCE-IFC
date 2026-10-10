"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { MODULES } from "@/config";
import { cn } from "@/lib/utils";
import { ThemeModeToggle } from "@/components/ThemeModeToggle";
import { LocaleToggle } from "@/components/LocaleToggle";
import Image from "next/image";

export function MainNav() {
  const pathname = usePathname();
  const t = useTranslations();

  return (
    <header className="bg-background sticky top-0 z-40 border-b">
      <nav className="flex items-center gap-1 px-4 py-2">
        <div className="flex items-center gap-2 md:gap-4">
          <Link
            href="https://isise.net/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image src="/isise-logo.svg" alt="ISISE" width={32} height={32} />
          </Link>
          <Link
            href="/"
            className="mr-3 font-mono text-sm font-semibold tracking-tight"
          >
            DiCE-IFC
          </Link>
        </div>

        <ul className="flex min-w-0 flex-1 items-center gap-0.5 grow">
          {MODULES.map((m) => {
            const active =
              pathname === m.href || pathname.startsWith(`${m.href}/`);
            return (
              <li key={m.href}>
                <Link
                  href={m.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "hover:bg-accent hover:text-accent-foreground rounded px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                    active
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {t(`modules.${m.key}.title`)}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="flex shrink-0 items-center gap-1">
          <Link
            href="/about"
            aria-current={pathname === "/about" ? "page" : undefined}
            className={cn(
              "hover:bg-accent hover:text-accent-foreground rounded px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
              pathname === "/about"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground",
            )}
          >
            {t("nav.about")}
          </Link>
          <LocaleToggle />
          <ThemeModeToggle />
        </div>
        <Link
          href="https://uminho.pt/"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image src="/uminho-logo.svg" alt="UMinho" width={41} height={32} />
        </Link>
      </nav>
    </header>
  );
}

export default MainNav;
