"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useValidateStore } from "@/lib/ids/validate-store";
import { getModelHandle } from "@/lib/viewer/loader";
import type { EntityRef } from "@/lib/viewer/store";
import { PropertyTable } from "./PropertyTable";
import { formatPropertyValue } from "@/lib/viewer/property-format";
import { useDisplaySettingsStore } from "@/lib/viewer/display-settings";
import { usePropertyTranslation } from "@/lib/bsdd/use-property-names";

/** Mounted only when its tab is open. No validation run is needed. */
export function IdsProperties({ entity, filter }: { entity: EntityRef; filter: string }) {
  const t = useTranslations("viewer.propertyPanel");
  const decimalPlaces = useDisplaySettingsStore((s) => s.propertyDecimalPlaces);
  const translate = usePropertyTranslation();
  const xml = useValidateStore((s) => s.idsXml);
  const title = useValidateStore((s) => s.idsTitle);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["viewer-ids-properties", entity.modelId, entity.expressId, xml],
    enabled: Boolean(xml),
    staleTime: 0,
    // Do not retain copies of a potentially large IDS for previous selections.
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const handle = getModelHandle(entity.modelId);
      if (!handle) throw new Error("Model is no longer loaded");
      return handle.getIdsProperties(entity.expressId, xml!);
    },
  });

  if (!xml) return <p className="text-muted-foreground text-xs">{t("ids.noFile")}</p>;
  if (isPending) return <p role="status" className="text-muted-foreground text-xs">{t("ids.loading")}</p>;
  if (isError) return (
    <div className="space-y-2 text-xs">
      <p role="alert" className="text-destructive">{t("ids.error")}</p>
      <Button size="sm" variant="outline" onClick={() => void refetch()}>{t("ids.retry")}</Button>
    </div>
  );

  const term = filter.trim().toLowerCase();
  const rows = (data ?? []).map((row) => ({
    ...row,
    translation: translate(row.propertySet, row.name),
    value: row.state === "missing" ? t("ids.missing") : row.state === "empty" ? t("emptyValue")
      : row.values.map((value) => formatPropertyValue(value, t("yes"), t("no"), row.unit, decimalPlaces)).join("; "),
  })).filter((row) => !term || [row.name, row.translation?.text ?? "", row.propertySet ?? t("attributes"), row.value, ...row.specifications]
    .some((value) => value.toLowerCase().includes(term)));

  return (
    <div className="space-y-3 text-xs" data-ids-properties>
      <div className="space-y-1">
        <p className="break-words font-medium">{title}</p>
        <p className="text-muted-foreground">{t("ids.hint")}</p>
      </div>
      {!data?.length ? <p className="text-muted-foreground">{t("ids.noRequirements")}</p>
        : !rows.length ? <p className="text-muted-foreground">{t("contextNoMatches")}</p>
        : <PropertyTable rows={rows.map((row) => ({
          ...row,
          idsProperty: row.name,
          details: [row.propertySet ?? t("attributes"), row.specifications.join(" · ")],
          unavailable: row.state !== "present",
        }))} />}
    </div>
  );
}
