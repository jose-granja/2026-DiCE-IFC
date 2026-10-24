"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("viewer.propertyPanel");
  const sections = (groups ?? [{ id: "all", rows }]).filter((group) => group.rows.length);
  if (!sections.length) return <p className="text-muted-foreground text-xs">{empty ?? t("contextNoMatches")}</p>;

  return (
    <table className="w-full table-fixed text-left text-xs" data-property-table>
      <thead><tr className="border-b text-muted-foreground">
        <th scope="col" className="w-3/5 pb-2 pr-2 font-medium">{t("property")}</th>
        <th scope="col" className="pb-2 font-medium">{t("value")}</th>
      </tr></thead>
      {sections.map((group) => <tbody key={group.id} data-property-group={group.name}>
        {group.name && <tr className="border-b bg-muted/40">
          <th scope="rowgroup" colSpan={2} className="break-words px-2 py-2 font-semibold">{group.name}</th>
        </tr>}
        {group.rows.map((row) => (
          <tr key={row.id} className="border-b align-top" data-ids-property={row.idsProperty}>
            <th scope="row" className="break-words py-2 pr-2 font-normal">
              <span className="font-medium">{row.name}</span>
              {row.details?.filter(Boolean).map((detail, index) => (
                <span key={index} className="text-muted-foreground block text-[10px]">{detail}</span>
              ))}
            </th>
            <td className={cn("whitespace-pre-wrap break-words py-2", row.mono && "font-mono break-all", row.unavailable && "text-destructive")}>
              {row.value || t("emptyValue")}
            </td>
          </tr>
        ))}
      </tbody>)}
    </table>
  );
}
