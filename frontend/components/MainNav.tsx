"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetClose } from "@/components/ui/sheet";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { MODULES } from "@/config";
import { cn } from "@/lib/utils";
import { ThemeModeToggle } from "@/components/ThemeModeToggle";
import { LocaleToggle } from "@/components/LocaleToggle";
import Image from "next/image";

export function MainNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const t = useTranslations();

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onChange = () => { if (desktop.matches) setMenuOpen(false); };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  return (
    <header className="main-nav bg-background sticky top-0 z-40 border-b">
      <nav aria-label={t("nav.navigation")} className="flex h-[3.25rem] min-w-0 items-center gap-1 px-2 lg:px-4">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11 shrink-0 lg:hidden" aria-label={t("nav.menu")}><Menu aria-hidden /></Button>
          </SheetTrigger>
          <SheetContent side="left" showCloseButton={false} className="mobile-navigation w-[min(22rem,100%)] overflow-y-auto" aria-describedby={undefined}>
            <div className="flex items-center justify-between border-b px-4 py-2">
              <SheetTitle>{t("nav.navigation")}</SheetTitle>
              <SheetClose asChild><Button variant="ghost" size="icon" className="size-11" aria-label={t("nav.closeMenu")}><X aria-hidden /></Button></SheetClose>
            </div>
            <nav className="flex flex-col gap-1 px-3 pb-4" aria-label={t("nav.navigation")}>
              {[...MODULES.map((m) => ({ href: m.href, label: t(`modules.${m.key}.title`) })), { href: "/about", label: t("nav.about") }].map(({ href, label }) => {
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return <Link key={href} href={href} onClick={() => setMenuOpen(false)} aria-current={active ? "page" : undefined} className={cn("flex min-h-11 items-center rounded-md px-3 py-2 text-sm hover:bg-accent", active && "bg-accent font-medium")}>{label}</Link>;
              })}
            </nav>
          </SheetContent>
        </Sheet>
        <div className="flex min-w-0 flex-1 items-center gap-2 lg:flex-none lg:gap-4">
          <Link
            href="https://isise.net/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image src="/isise-logo.svg" alt="ISISE" width={32} height={32} />
          </Link>
          <Link
            href="/"
            className="truncate font-mono text-sm font-semibold tracking-tight lg:mr-3"
          >
            DiCE-IFC
          </Link>
        </div>

        <ul className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 lg:flex">
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
              "hidden hover:bg-accent hover:text-accent-foreground rounded px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors lg:block",
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
          className="hidden shrink-0 sm:block"
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
