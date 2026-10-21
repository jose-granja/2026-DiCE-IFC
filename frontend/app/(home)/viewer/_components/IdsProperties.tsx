"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useValidateStore } from "@/lib/ids/validate-store";
import { getModelHandle } from "@/lib/viewer/loader";
import type { EntityRef } from "@/lib/viewer/store";

/** Mounted only when its tab is open. No validation run is needed. */
export function IdsProperties({ entity, filter }: { entity: EntityRef; filter: string }) {
  const t = useTranslations("viewer.propertyPanel");
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
    value: row.state === "missing" ? t("ids.missing") : row.state === "empty" ? t("ids.emptyValue")
      : row.values.map((value) => typeof value === "boolean" ? t(value ? "yes" : "no") : String(value ?? "")).join("; "),
  })).filter((row) => !term || [row.name, row.propertySet ?? t("attributes"), row.value, ...row.specifications]
    .some((value) => value.toLowerCase().includes(term)));

  return (
    <div className="space-y-3 text-xs" data-ids-properties>
      <div className="space-y-1">
        <p className="break-words font-medium">{title}</p>
        <p className="text-muted-foreground">{t("ids.hint")}</p>
      </div>
      {!data?.length ? <p className="text-muted-foreground">{t("ids.noRequirements")}</p>
        : !rows.length ? <p className="text-muted-foreground">{t("contextNoMatches")}</p>
        : <table className="w-full table-fixed text-left">
          <thead><tr className="border-b text-muted-foreground">
            <th scope="col" className="w-3/5 pb-2 pr-2 font-medium">{t("ids.property")}</th>
            <th scope="col" className="pb-2 font-medium">{t("ids.value")}</th>
          </tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id} className="border-b align-top" data-ids-property={row.name}>
              <th scope="row" className="break-words py-2 pr-2 font-normal">
                <span className="font-medium">{row.name}</span>
                <span className="text-muted-foreground block text-[10px]">{row.propertySet ?? t("attributes")}</span>
                <span className="text-muted-foreground block text-[10px]">{row.specifications.join(" · ")}</span>
              </th>
              <td className={`break-words py-2 ${row.state === "present" ? "" : "text-destructive"}`}>{row.value}</td>
            </tr>
          ))}</tbody>
        </table>}
    </div>
  );
}
