"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { LogOut, User as UserIcon } from "lucide-react";

import { MODULES } from "@/config";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/provider";
import { Button } from "@/components/ui/button";
import { ThemeModeToggle } from "@/components/ThemeModeToggle";
import { LocaleToggle } from "@/components/LocaleToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function MainNav() {
  const pathname = usePathname();
  const { user, isLoading, signOut } = useAuth();
  const t = useTranslations();

  return (
    <header className="bg-background sticky top-0 z-40 border-b">
      <nav className="flex items-center gap-1 px-4 py-2">
        <Link
          href="/"
          className="mr-3 font-mono text-sm font-semibold tracking-tight"
        >
          DiCE-IFC
        </Link>

        <ul className="flex min-w-0 flex-1 items-center gap-0.5">
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
          <LocaleToggle />
          <ThemeModeToggle />
          {isLoading ? null : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("nav.account")}>
                  <UserIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="max-w-56 truncate font-normal">
                  {user.email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/privacy">{t("nav.whatLeaves")}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => signOut()}>
                  <LogOut className="h-4 w-4" />
                  {t("nav.signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/sign-in">{t("nav.signIn")}</Link>
            </Button>
          )}
        </div>
      </nav>
    </header>
  );
}

export default MainNav;
