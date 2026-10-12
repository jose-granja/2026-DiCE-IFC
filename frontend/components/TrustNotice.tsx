"use client";

import type { ReactNode } from "react";
import { ChevronDown, ShieldQuestion } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * What a signature check does and does not establish, folded away until wanted.
 *
 * The wording is deliberate and must stay one click from view — a green "valid"
 * that never says it is not a trust decision would overstate what the page
 * proves — but it is also the same paragraph on every signing and verifying page,
 * and a paragraph that is always open becomes one nobody reads. So it is
 * collapsed, with a summary line that says what is inside.
 *
 * A native `<details>`: keyboard operable, announced as expandable, and no
 * script. Its content stays in the DOM when closed, so it can still be found by
 * text search and read by assistive technology that walks the page.
 */
export function TrustNotice({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const t = useTranslations("trustNotice");

  return (
    <details
      {...rest}
      className={cn("group bg-muted/50 text-muted-foreground rounded-lg text-sm", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 p-3 font-medium [&::-webkit-details-marker]:hidden">
        <ShieldQuestion className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t("summary")}</span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <p className="px-3 pb-3 pl-9">{children}</p>
    </details>
  );
}

export default TrustNotice;
