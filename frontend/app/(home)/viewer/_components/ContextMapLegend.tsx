"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ContextLegend } from "@/lib/georef/context-geometry";

export function ContextMapLegend({ legend }: { legend: ContextLegend }) {
  const t = useTranslations("viewer.contextModel.service");
  return <Collapsible defaultOpen className="rounded border" data-context-map-legend>
    <CollapsibleTrigger asChild>
      <Button variant="ghost" className="group h-8 w-full justify-between px-2 text-xs">
        {t("legend")}<ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-1 px-2 pb-2">
      <p className="text-muted-foreground truncate text-[11px]" title={legend.title}>{legend.title}</p>
      <div className="max-h-64 overflow-auto rounded bg-white p-1" tabIndex={0} role="region" aria-label={t("legendFor", { layer:legend.title })}>
        <LegendImage legend={legend} />
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

function LegendImage({ legend }: { legend: ContextLegend }) {
  const t = useTranslations("viewer.contextModel.service");
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    // The URL belongs to the mounted image, including collapse/reopen and
    // StrictMode remounts. No remote image URL reaches the browser or Next.
    const url = URL.createObjectURL(legend.image);
    element.src = url;
    return () => { element.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [legend.image]);
  // eslint-disable-next-line @next/next/no-img-element -- local blob, no image optimizer or network request
  return <img ref={image} alt={t("legendFor", { layer:legend.title })} className="block max-w-none" />;
}
