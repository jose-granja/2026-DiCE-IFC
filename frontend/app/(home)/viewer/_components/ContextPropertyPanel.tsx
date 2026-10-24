"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ContextFeature } from "@/lib/georef/context-geometry";
import { PropertyTable } from "./PropertyTable";

export function ContextPropertyPanel({ feature, filename, epsg }: {
  feature: ContextFeature;
  filename?: string;
  epsg: number | null;
}) {
  const t = useTranslations("viewer.propertyPanel");
  const [filter, setFilter] = useState("");
  const format = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "boolean") return t(value ? "yes" : "no");
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
  };
  const term = filter.trim().toLocaleLowerCase();
  const rows = Object.entries(feature.properties)
    .map(([key, value]) => [key, format(value)])
    .filter(([key, value]) => !term || `${key} ${value}`.toLocaleLowerCase().includes(term));
  const details = [
    [t("contextSource"), feature.source],
    [t("contextId"), feature.id],
    ...(feature.layer ? [[t("contextLayer"), feature.layer]] : []),
    ...(epsg !== null ? [[t("contextCrs"), `EPSG:${epsg}`]] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-property-panel data-context-properties>
      <div className="space-y-2 border-b p-3">
        <p className="text-muted-foreground truncate text-xs" title={filename}>{filename}</p>
        <h3 className="break-words text-sm font-semibold">{feature.name ?? feature.id}</h3>
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">{t("contextFeature")}</Badge>
          <Badge variant="outline">{feature.type}</Badge>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        <div className="mb-4">
          <PropertyTable rows={details.map(([key, value]) => ({ id: key, name: key, value }))} />
        </div>
        <div className="relative mb-3">
          <Search aria-hidden className="text-muted-foreground absolute top-2.5 left-2 h-3.5 w-3.5" />
          <Input className="h-8 pl-7 text-xs" aria-label={t("filterProperties")} placeholder={t("filterProperties")}
            value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>
        <h4 className="mb-2 font-medium">{t("attributes")}</h4>
        <PropertyTable rows={rows.map(([key, value]) => ({ id: key, name: key, value: value || "—" }))}
          empty={t(term ? "contextNoMatches" : "contextNoMetadata")} />
      </div>
    </div>
  );
}
