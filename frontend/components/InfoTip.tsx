"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Help text behind an "i": shown on hover and keyboard focus, as a tooltip is,
 * and also on a tap — a touch screen has no hover, and help that a phone
 * cannot open is help half the users never see.
 *
 * Its accessible name is "More information", not the topic's: it sits beside
 * what it explains, and repeating that label in the button would give two
 * controls the same name — a switch and its "i" both "Add a time-stamp".
 */
export function InfoTip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const t = useTranslations("infoTip");
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("label")}
          data-info-tip
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]",
            className,
          )}
          onClick={(event) => {
            // Radix closes a tooltip on a click of its trigger; here a click
            // (a tap) is how it opens on a phone.
            event.preventDefault();
            setOpen((current) => !current);
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left" data-info-tip-content>
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
