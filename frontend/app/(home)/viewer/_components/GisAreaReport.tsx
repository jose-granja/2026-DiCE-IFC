"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, MapPinned, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { areaReportCsv, type AreaLayerResult, type AreaReport } from "@/lib/georef/area-check";
import { useContextModelStore } from "@/lib/viewer/context-model-store";
import { useGisAreaStore } from "@/lib/viewer/gis-area-store";

export function GisAreaReport({ report }: { report: AreaReport }) {
  const t = useTranslations("viewer.gisAreas");
  const viewing = useGisAreaStore((s) => !!s.viewRequest);
  const viewError = useGisAreaStore((s) => s.viewError);
  const done = report.layers.filter((layer) => layer.status !== "pending").length;
  const matches = report.layers.reduce((count, layer) => count + layer.matches.length, 0);
  const errors = report.layers.filter((layer) => layer.status === "error").length;
  const download = () => {
    const url = URL.createObjectURL(new Blob([areaReportCsv(report)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "gis-area-results.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="flex min-h-0 flex-1 flex-col text-xs" data-property-panel data-gis-area-report>
    <div className="space-y-2 border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("close")} onClick={() => useGisAreaStore.getState().hide()}><X className="h-3.5 w-3.5" /></Button>
      </div>
      <p className="break-words font-medium">{report.model}</p>
      <p className="text-muted-foreground break-words">{report.source} · EPSG:{report.epsg}</p>
      <p className="text-muted-foreground">{t("method")}</p>
      <p className="text-muted-foreground">{t(report.scope === "loaded" ? "loadedScope" : "wfsScope")}</p>
      <p role="status">{t("summary", { done, total: report.layers.length, matches })}</p>
      {viewing && <p role="status">{t("showingArea")}</p>}
      {viewError && <p role="alert" className="text-destructive">{viewError}</p>}
      {report.status === "running" && <p>{t("checking")}</p>}
      {report.status === "cancelled" && <p className="text-destructive">{t("cancelled")}</p>}
      {errors > 0 && <p className="text-destructive">{t("failed", { count: errors })}</p>}
      <p className="text-muted-foreground">{t("snapshot", { time: new Date(report.checkedAt).toLocaleString() })}</p>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={report.status === "running"} onClick={download}><Download className="h-3.5 w-3.5" aria-hidden />{t("download")}</Button>
    </div>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {report.layers.map((layer, index) => <LayerResult key={`${report.checkedAt}-${index}`} layer={layer} layerIndex={index} />)}
    </div>
  </div>;
}

function LayerResult({ layer, layerIndex }: { layer: AreaLayerResult; layerIndex: number }) {
  const t = useTranslations("viewer.gisAreas");
  const service = useTranslations("viewer.contextModel.service.errors");
  const disabled = useGisAreaStore((s) => s.busy || !!s.viewRequest);
  const selectedFeature = useContextModelStore((s) => s.selectedFeature);
  const currentFile = useContextModelStore((s) => s.file);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.ceil(layer.matches.length / 50);
  const error = layer.error ? t.has(`errors.${layer.error}`) ? t(`errors.${layer.error}`)
    : service.has(layer.error) ? service(layer.error) : t("errors.invalidFeatureFile") : null;
  return <div className="rounded-md border p-2" data-gis-area-layer>
    <p className="break-words font-medium">{layer.title}</p>
    {layer.name !== layer.title && <p className="text-muted-foreground break-all">{layer.name}</p>}
    <p className={layer.status === "error" ? "text-destructive" : "text-muted-foreground"}>{t(`status.${layer.status}`, { count: layer.matches.length })}</p>
    {error && <p className="text-destructive mt-1">{error}</p>}
    {layer.matches.length > 0 && <>
      <Button size="sm" variant="ghost" className="mt-1 h-6 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? "hideAreas" : "showAreas")}</Button>
      {open && <div className="mt-2 space-y-2">
        {layer.matches.slice(page * 50, (page + 1) * 50).map((feature, index) => <details key={`${page}-${index}`} className="rounded border p-2">
          <summary className="cursor-pointer break-words font-medium" aria-disabled={disabled || !layer.view}
            title={t("showOnMap", { name: feature.name ?? feature.id })}
            onClick={() => { if (!disabled) useGisAreaStore.getState().view(layerIndex, page * 50 + index); }}>
            {feature.name ?? feature.id}
            <MapPinned className="ml-1 inline h-3.5 w-3.5" aria-hidden />
            {currentFile === layer.view?.file && selectedFeature === layer.view?.featureIndices[page * 50 + index]
              && <span className="text-primary ml-1 text-[10px]">{t("highlighted")}</span>}
          </summary>
          <p className="text-muted-foreground my-2 break-words">{t("featureId", { id: feature.id })}</p>
          <dl className="divide-y">{Object.entries(feature.properties).map(([key, value]) => <div key={key} className="grid grid-cols-2 gap-2 py-1">
            <dt className="text-muted-foreground break-words">{key}</dt>
            <dd className="whitespace-pre-wrap break-words">{value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
          </div>)}</dl>
        </details>)}
        {pages > 1 && <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" className="h-6 text-xs" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("previous")}</Button>
          <span>{t("page", { page: page + 1, pages })}</span>
          <Button size="sm" variant="outline" className="h-6 text-xs" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t("next")}</Button>
        </div>}
      </div>}
    </>}
  </div>;
}
