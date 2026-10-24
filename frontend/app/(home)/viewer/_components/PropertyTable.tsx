"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type PropertyTableRow = {
  id: string;
  name: string;
  value: string;
  details?: string[];
  mono?: boolean;
  unavailable?: boolean;
  idsProperty?: string;
};

export type PropertyTableGroup = { id: string; name?: string; rows: PropertyTableRow[] };

/** One layout for IFC attributes, property sets, IDS requirements and GIS metadata. */
export function PropertyTable({ rows = [], groups, empty }: { rows?: PropertyTableRow[]; groups?: PropertyTableGroup[]; empty?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const t = useTranslations("viewer.propertyPanel");
  const sections = (groups ?? [{ id: "all", rows }]).filter((group) => group.rows.length);
  if (!sections.length) return <p className="text-muted-foreground text-xs">{empty ?? t("contextNoMatches")}</p>;

  return (
    <table className="w-full table-fixed text-left text-xs" data-property-table>
      <thead><tr className="border-b text-muted-foreground">
        <th scope="col" className="w-3/5 pb-2 pr-2 font-medium">{t("property")}</th>
        <th scope="col" className="pb-2 font-medium">{t("value")}</th>
      </tr></thead>
      {sections.map((group) => {
        const isOpen = !group.name || (open[group.id] ?? true);
        return (
          <tbody key={group.id} data-property-group={group.name}>
            {group.name && <tr className="border-b bg-muted/40">
              <th scope="rowgroup" colSpan={2} className="p-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen((prev) => ({ ...prev, [group.id]: !isOpen }))}
                  className="flex w-full cursor-pointer items-center gap-2 px-2 py-2 text-left font-semibold hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 transition-transform", !isOpen && "-rotate-90")} />
                  <span className="min-w-0 wrap-break-word">{group.name}</span>
                </button>
              </th>
            </tr>}
            {isOpen && group.rows.map((row) => (
              <tr key={row.id} className="border-b align-top" data-ids-property={row.idsProperty}>
                <th scope="row" className="wrap-break-word py-2 px-2 font-normal">
                  <span className="font-medium">{row.name}</span>
                  {row.details?.filter(Boolean).map((detail, index) => (
                    <span key={index} className="text-muted-foreground block text-[10px]">{detail}</span>
                  ))}
                </th>
                <td className={cn("whitespace-pre-wrap wrap-break-word py-2", row.mono && "font-mono break-all", row.unavailable && "text-destructive")}>
                  {row.value || t("emptyValue")}
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}
