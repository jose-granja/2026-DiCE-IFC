"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { findCrs } from "@/config/epsg";
import { getModelHandle } from "@/lib/viewer/loader";
import { gridRotation } from "@/lib/georef/transform";
import { hasChanges, useGeorefStore } from "@/lib/georef/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DiffRow = { label: string; before: string; after: string; changed: boolean };

/**
 * The before/after diff, and the corrected export.
 *
 * **The export is a new file, never an edit of the loaded one.** The adapter
 * stages georeferencing as a mutation applied at export time, so the parsed
 * store and the original bytes are untouched — which is what lets the same
 * session sign the original afterwards (ADR 002: a STEP round-trip reorders
 * instances and would invalidate any signature over the source).
 */
export function WriteBackPanel({ modelName }: { modelName: string }) {
  const t = useTranslations("viewer.georefPanel.writeBack");
  const modelId = useGeorefStore((s) => s.modelId);
  const draft = useGeorefStore((s) => s.draft);
  const original = useGeorefStore((s) => s.original);
  const [exporting, setExporting] = useState(false);

  const dirty = hasChanges(original, draft);
  const rows = buildDiff(original, draft, t);

  const onExport = async () => {
    if (!modelId || !draft) return;
    const handle = getModelHandle(modelId);
    if (!handle) {
      toast.error(t("modelNoLongerLoaded"));
      return;
    }

    setExporting(true);
    toast.loading(t("writingModel"), { id: "georef-export" });

    try {
      const crs = findCrs(draft.epsg);
      // Only what changed: writing a site position the file already had would
      // re-round it for nothing.
      const siteChanges: { latitude?: number; longitude?: number; elevation?: number } = {};
      for (const key of ["latitude", "longitude", "elevation"] as const) {
        const next = draft.site?.[key] ?? null;
        if (next !== null && next !== (original?.site?.[key] ?? null)) siteChanges[key] = next;
      }
      const result = await handle.exportStep({
        georeference: {
          ...(Object.keys(siteChanges).length > 0 ? { site: siteChanges } : {}),
          mapConversion: draft.conversion,
          projectedCRS: crs
            ? {
                name: crs.name,
                description: crs.label,
                // Only what is filled in: an empty field means "not stated",
                // and writing '' would turn that into an empty string.
                geodeticDatum: draft.crs?.geodeticDatum?.trim() || crs.geodeticDatum,
                ...(draft.crs?.verticalDatum?.trim()
                  ? { verticalDatum: draft.crs.verticalDatum.trim() }
                  : {}),
                ...(draft.crs?.mapProjection?.trim()
                  ? { mapProjection: draft.crs.mapProjection.trim() }
                  : {}),
                ...(draft.crs?.mapZone?.trim() ? { mapZone: draft.crs.mapZone.trim() } : {}),
                mapUnit: "METRE",
              }
            : undefined,
        },
      });

      // Saved straight to disk from the tab; the bytes never touch the network.
      const blob = new Blob([result.content as BlobPart], {
        type: "application/x-step",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = modelName.replace(/\.ifc$/i, "") + "-georeferenced.ifc";
      link.click();
      URL.revokeObjectURL(url);

      if (result.warnings.length > 0) {
        // Never silently drop a requested change: an IfcMapConversion with no
        // representation context to reference is skipped by the exporter, and
        // the output would otherwise be indistinguishable from success.
        toast.warning(result.warnings.join(" "), {
          id: "georef-export",
          duration: 12_000,
        });
      } else {
        toast.success(
          t("exportedEntities", { count: result.entityCount }),
          { id: "georef-export" },
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("exportFailed"),
        { id: "georef-export" },
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="border-b p-2">
        <Button
          size="sm"
          className="w-full"
          disabled={!draft || exporting}
          onClick={onExport}
        >
          <Download className="h-4 w-4" />
          {exporting ? t("exporting") : t("exportCorrectedIfc")}
        </Button>
        <p className="text-muted-foreground mt-1.5 text-[11px]">
          {t("exportHint")}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground p-3 text-xs">
          {t("nothingToCompare")}
        </p>
      ) : (
        <table className="w-full text-xs">
          <caption className="text-muted-foreground px-3 pt-2 pb-1 text-left text-[11px]">
            {dirty ? t("changesToBeWritten") : t("noChanges")}
          </caption>
          <thead>
            <tr className="text-muted-foreground border-b">
              <th scope="col" className="px-3 py-1 text-left font-medium">
                {t("fieldColumn")}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t("beforeColumn")}
              </th>
              <th scope="col" className="px-3 py-1 text-right font-medium">
                {t("afterColumn")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className={cn("border-b", row.changed && "bg-warning/10")}
              >
                <th scope="row" className="px-3 py-1 text-left font-normal">
                  {row.label}
                </th>
                <td className="text-muted-foreground px-3 py-1 text-right font-mono tabular-nums">
                  {row.before}
                </td>
                <td
                  className={cn(
                    "px-3 py-1 text-right font-mono tabular-nums",
                    row.changed && "font-medium",
                  )}
                >
                  {row.after}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function buildDiff(
  original: ReturnType<typeof useGeorefStore.getState>["original"],
  draft: ReturnType<typeof useGeorefStore.getState>["draft"],
  t: ReturnType<typeof useTranslations>,
): DiffRow[] {
  if (!draft) return [];

  const before = original;
  const row = (label: string, a: string, b: string): DiffRow => ({
    label,
    before: a,
    after: b,
    changed: a !== b,
  });

  const number = (value: number | undefined, digits = 3) =>
    value === undefined ? "—" : value.toFixed(digits);
  const degrees = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${value.toFixed(7)}°`;

  return [
    row(
      "IfcProjectedCRS.Name",
      findCrs(before?.epsg)?.name ?? "—",
      findCrs(draft.epsg)?.name ?? "—",
    ),
    row(
      "IfcSite.RefLatitude",
      degrees(before?.site?.latitude),
      degrees(draft.site?.latitude),
    ),
    row(
      "IfcSite.RefLongitude",
      degrees(before?.site?.longitude),
      degrees(draft.site?.longitude),
    ),
    row(
      "IfcSite.RefElevation",
      number(before?.site?.elevation ?? undefined),
      number(draft.site?.elevation ?? undefined),
    ),
    row(
      "IfcProjectedCRS.GeodeticDatum",
      before?.crs?.geodeticDatum || "—",
      draft.crs?.geodeticDatum || findCrs(draft.epsg)?.geodeticDatum || "—",
    ),
    row(
      "IfcProjectedCRS.VerticalDatum",
      before?.crs?.verticalDatum || "—",
      draft.crs?.verticalDatum || "—",
    ),
    row(
      "IfcProjectedCRS.MapProjection",
      before?.crs?.mapProjection || "—",
      draft.crs?.mapProjection || "—",
    ),
    row(
      "IfcProjectedCRS.MapZone",
      before?.crs?.mapZone || "—",
      draft.crs?.mapZone || "—",
    ),
    row(
      t("eastings"),
      number(before?.conversion.eastings),
      number(draft.conversion.eastings),
    ),
    row(
      t("northings"),
      number(before?.conversion.northings),
      number(draft.conversion.northings),
    ),
    row(
      "OrthogonalHeight",
      number(before?.conversion.orthogonalHeight),
      number(draft.conversion.orthogonalHeight),
    ),
    row(
      t("gridRotation"),
      before ? `${gridRotation(before.conversion).degrees.toFixed(4)}°` : "—",
      `${gridRotation(draft.conversion).degrees.toFixed(4)}°`,
    ),
    row(
      t("scale"),
      number(before?.conversion.scale ?? (before ? 1 : undefined), 8),
      number(draft.conversion.scale ?? 1, 8),
    ),
  ];
}

export default WriteBackPanel;
